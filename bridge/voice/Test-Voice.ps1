param(
    [string]$VoiceToken='ForeverAssistantSilentBridge3',
    [ValidateSet('LocalMachine','CurrentUser')][string]$RegistryScope='LocalMachine',
    [string]$CommandText='FAV1:PING:windows-roundtrip',
    [string]$Expected='FAV1:PONG:windows-roundtrip',
    [switch]$Batch
)
$ErrorActionPreference='Stop'
if($PSVersionTable.PSEdition -ne 'Desktop'){throw 'Run this probe with Windows PowerShell (powershell.exe).'}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VoiceProbeEvents {
    [StructLayout(LayoutKind.Sequential)] public struct Event {
        public ushort Id, Type; public uint Stream; public ulong Offset; public UIntPtr W; public IntPtr L;
    }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Interest(IntPtr self, ulong interest, ulong queued);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Events(IntPtr self, uint count, out Event item, out uint fetched);
    public static IntPtr Attach(object voice) {
        IntPtr unknown=Marshal.GetIUnknownForObject(voice), source;
        Guid iid=new Guid("BE7A9CCE-5F9E-11D2-960F-00C04F8EE628");
        try {Marshal.ThrowExceptionForHR(Marshal.QueryInterface(unknown,ref iid,out source));} finally {Marshal.Release(unknown);}
        IntPtr table=Marshal.ReadIntPtr(source);
        Interest set=(Interest)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(table,10*IntPtr.Size),typeof(Interest));
        ulong mask=(1UL<<4)|(1UL<<30)|(1UL<<33);
        Marshal.ThrowExceptionForHR(set(source,mask,mask)); return source;
    }
    public static string Read(IntPtr source) {
        Events get=(Events)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(source),11*IntPtr.Size),typeof(Events));
        Event item; uint count; Marshal.ThrowExceptionForHR(get(source,1,out item,out count));
        if(count==0)return null;
        string result=item.Id==4?Marshal.PtrToStringUni(item.L):"unexpected-event";
        if(item.Type==4 && item.L!=IntPtr.Zero)Marshal.FreeCoTaskMem(item.L);
        return result;
    }
}
'@
$taskVoice=New-Object -ComObject SAPI.SpVoice
$taskToken=New-Object -ComObject SAPI.SpObjectToken
$taskHive=if($RegistryScope -eq 'LocalMachine'){'HKEY_LOCAL_MACHINE'}else{'HKEY_CURRENT_USER'}
$taskToken.SetId(($taskHive+'\Software\Microsoft\Speech\Voices\Tokens\'+$VoiceToken),'',$false)
$taskVoice.Voice=$taskToken
$taskStream=New-Object -ComObject SAPI.SpMemoryStream
$taskFormat=New-Object -ComObject SAPI.SpAudioFormat
$taskFormat.Type=22
$taskStream.Format=$taskFormat
$taskVoice.AudioOutputStream=$taskStream
$taskSource=[VoiceProbeEvents]::Attach($taskVoice)
try {
    [void]$taskVoice.Speak($CommandText,0)
    $taskMarks=@()
    while($taskMark=[VoiceProbeEvents]::Read($taskSource)){$taskMarks+=$taskMark}
    if($Batch) {
        if($taskMarks.Count -ne 8){throw "Expected 8 bookmarks, got $($taskMarks.Count)"}
        if(@($taskMarks | Where-Object {!$_.StartsWith($Expected)}).Count -ne 0){throw 'Unexpected batch prefix.'}
    } elseif($taskMarks.Count -ne 1 -or $taskMarks[0] -ne $Expected){throw 'Unexpected bookmark reply.'}
    $taskData=$taskStream.GetData()
    $taskNonzero=@($taskData | Where-Object {$_ -ne 0}).Count
    if($taskNonzero -ne 0){throw 'Voice produced non-silent PCM.'}
    [PSCustomObject]@{Bookmarks=$taskMarks.Count;LongestBookmark=($taskMarks|ForEach-Object {$_.Length}|Measure-Object -Maximum).Maximum;AudioBytes=$taskData.Length;NonzeroAudioBytes=$taskNonzero;Result='PASS'} | ConvertTo-Json -Compress
} finally {[void][Runtime.InteropServices.Marshal]::Release($taskSource)}

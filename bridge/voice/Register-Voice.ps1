param([switch]$Uninstall,[switch]$Machine)
$ErrorActionPreference='Stop'
$taskRegistry=if($Machine){[Microsoft.Win32.Registry]::LocalMachine}else{[Microsoft.Win32.Registry]::CurrentUser}
$taskClsid='{FD0302DD-34DE-44AD-8DCE-02A6C4A03303}'
$taskClassPath="Software\Classes\CLSID\$taskClsid"
$taskVoicePath='Software\Microsoft\Speech\Voices\Tokens\ForeverAssistantSilentBridge3'
if($Uninstall) {
    # These are the two fixed keys owned exclusively by this component.
    $taskRegistry.DeleteSubKeyTree($taskVoicePath,$false)
    $taskRegistry.DeleteSubKeyTree($taskClassPath,$false)
    Write-Output 'Forever Assistant voice unregistered.'
    exit
}
$taskDll=Join-Path $PSScriptRoot 'ForeverAssistant.SilentVoice3.dll'
if(!(Test-Path -LiteralPath $taskDll)){throw 'Compile SilentVoice.cs before registering the voice.'}
$taskAssembly=[Reflection.AssemblyName]::GetAssemblyName($taskDll)
$taskClass=$taskRegistry.CreateSubKey($taskClassPath)
try {
    $taskClass.SetValue('','Forever Assistant Silent Voice')
    $taskServer=$taskClass.CreateSubKey('InprocServer32')
    try {
        $taskServer.SetValue('','mscoree.dll')
        $taskServer.SetValue('ThreadingModel','Both')
        $taskServer.SetValue('Class','ForeverAssistant.Voice.SilentVoice')
        $taskServer.SetValue('Assembly',$taskAssembly.FullName)
        $taskServer.SetValue('RuntimeVersion','v4.0.30319')
        $taskServer.SetValue('CodeBase',([Uri]$taskDll).AbsoluteUri)
    } finally {$taskServer.Dispose()}
} finally {$taskClass.Dispose()}
$taskVoice=$taskRegistry.CreateSubKey($taskVoicePath)
try {
    $taskVoice.SetValue('','Forever Assistant Silent Bridge 3')
    $taskVoice.SetValue('409','Forever Assistant Silent Bridge 3')
    $taskVoice.SetValue('CLSID',$taskClsid)
    $taskAttributes=$taskVoice.CreateSubKey('Attributes')
    try {
        $taskAttributes.SetValue('Name','Forever Assistant Silent Bridge 3')
        $taskAttributes.SetValue('Vendor','ForeverAssistant Local')
        $taskAttributes.SetValue('Language','409')
        $taskAttributes.SetValue('Gender','Neutral')
        $taskAttributes.SetValue('Age','Adult')
    } finally {$taskAttributes.Dispose()}
} finally {$taskVoice.Dispose()}
Write-Output 'Forever Assistant silent voice registered. Default voice unchanged.'

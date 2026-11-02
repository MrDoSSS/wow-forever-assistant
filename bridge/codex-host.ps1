# Codex process host. Manages only the process tree:
# Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and CreateProcessW(CREATE_SUSPENDED),
# job assignment, the prepared event and the resume command. If the bridge (ParentPid)
# or host dies, the job closes and the entire tree exits. Add-Type runs only our code.
#
# Protocol: JSON lines over stdio.
#   Bridge -> host: first line {"exe":"...","args":[...],"cwd":"..."}, then commands.
#     {"type":"resume"} | {"type":"stdin","data":"<base64>"} | {"type":"stdin_close"} | {"type":"stop"}
#   Host -> bridge:
#     {"type":"prepared","pid":N,"createdAt":ms,"hostPid":N,"hostCreatedAt":ms}
#     {"type":"stdout"|"stderr","data":"<base64>"}
#     {"type":"stopped","activeProcesses":N}
#     {"type":"exit","code":N,"activeProcesses":N}
#     {"type":"error","code":"process_host_unavailable","detail":"…"}
# -Check mode: {"type":"check","job":"absent|stopped","activeProcesses":N,"child":"absent|terminated|reused|none"}

param(
  [Parameter(Mandatory = $true)][string]$JobName,
  [int]$ParentPid = 0,
  [switch]$Check,
  [int]$ChildPid = 0,
  [long]$ChildCreatedAt = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Text.RegularExpressions;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class FaHost {
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
    public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime; public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount; public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses;
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, int length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, int mask, int flags);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, int flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
  [DllImport("kernel32.dll", SetLastError = true)] static extern int ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern int WaitForSingleObject(IntPtr handle, int milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out int exitCode);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();

  const int JobObjectBasicAccountingInformation = 1;
  const int JobObjectExtendedLimitInformation = 9;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
  const int CREATE_SUSPENDED = 0x4;
  const int CREATE_NO_WINDOW = 0x08000000;
  const int STARTF_USESTDHANDLES = 0x100;
  const int HANDLE_FLAG_INHERIT = 1;
  const int SYNCHRONIZE = 0x00100000;
  const int PROCESS_TERMINATE = 0x1;
  const int PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const uint JOB_OBJECT_QUERY = 0x4;
  const uint JOB_OBJECT_TERMINATE = 0x8;

  static readonly object writeLock = new object();

  static void Emit(string json) {
    lock (writeLock) { Console.Out.WriteLine(json); Console.Out.Flush(); }
  }

  static string Escape(string s) {
    return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
  }

  static long FileTimeToUnixMs(long fileTime) { return fileTime / 10000 - 11644473600000L; }

  public static long CreatedAt(IntPtr process) {
    long creation, exit, kernel, user;
    return GetProcessTimes(process, out creation, out exit, out kernel, out user) ? FileTimeToUnixMs(creation) : 0;
  }

  // MSVCRT/CommandLineToArgvW command-line parsing rules.
  public static string Quote(string arg) {
    if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return arg;
    var sb = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in arg) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); slashes = 0; continue; }
      sb.Append('\\', slashes); slashes = 0; sb.Append(c);
    }
    sb.Append('\\', slashes * 2);
    sb.Append('"');
    return sb.ToString();
  }

  static uint ActiveProcesses(IntPtr job) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out info, Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero)) return uint.MaxValue;
    return info.ActiveProcesses;
  }

  static uint StopJob(IntPtr job) {
    TerminateJobObject(job, 1);
    for (int i = 0; i < 100; i++) {
      uint active = ActiveProcesses(job);
      if (active == 0) return 0;
      Thread.Sleep(50);
    }
    return ActiveProcesses(job);
  }

  static void Pump(Stream stream, string kind) {
    var buffer = new byte[8192];
    try {
      int read;
      while ((read = stream.Read(buffer, 0, buffer.Length)) > 0) {
        Emit("{\"type\":\"" + kind + "\",\"data\":\"" + Convert.ToBase64String(buffer, 0, read) + "\"}");
      }
    } catch (IOException) { }
  }

  static void Fail(string detail) {
    Emit("{\"type\":\"error\",\"code\":\"process_host_unavailable\",\"detail\":\"" + Escape(detail) + "\"}");
  }

  public static int Run(string exe, string[] args, string cwd, string jobName, int parentPid) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, jobName);
    if (job == IntPtr.Zero) { Fail("CreateJobObject " + Marshal.GetLastWin32Error()); return 2; }
    var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) {
      Fail("SetInformationJobObject " + Marshal.GetLastWin32Error()); return 2;
    }

    var sa = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = 1 };
    IntPtr inRead, inWrite, outRead, outWrite, errRead, errWrite;
    if (!CreatePipe(out inRead, out inWrite, ref sa, 0) || !CreatePipe(out outRead, out outWrite, ref sa, 0) || !CreatePipe(out errRead, out errWrite, ref sa, 0)) {
      Fail("CreatePipe " + Marshal.GetLastWin32Error()); return 2;
    }
    // The child inherits neither the host's pipe ends nor the sole job handle.
    SetHandleInformation(inWrite, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(errRead, HANDLE_FLAG_INHERIT, 0);

    var startup = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)), dwFlags = STARTF_USESTDHANDLES, hStdInput = inRead, hStdOutput = outWrite, hStdError = errWrite };
    var commandLine = new StringBuilder(Quote(exe));
    foreach (var arg in args) { commandLine.Append(' '); commandLine.Append(Quote(arg)); }
    PROCESS_INFORMATION child;
    if (!CreateProcessW(exe, commandLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, cwd, ref startup, out child)) {
      Fail("CreateProcess " + Marshal.GetLastWin32Error()); return 2;
    }
    CloseHandle(inRead); CloseHandle(outWrite); CloseHandle(errWrite);
    if (!AssignProcessToJobObject(job, child.hProcess)) {
      int error = Marshal.GetLastWin32Error();
      TerminateProcess(child.hProcess, 1);
      Fail("AssignProcessToJobObject " + error); return 2;
    }

    Emit("{\"type\":\"prepared\",\"pid\":" + child.dwProcessId + ",\"createdAt\":" + CreatedAt(child.hProcess) +
      ",\"hostPid\":" + System.Diagnostics.Process.GetCurrentProcess().Id + ",\"hostCreatedAt\":" + CreatedAt(GetCurrentProcess()) + "}");

    // Bridge death closes the job: the host exits and its final job handle closes.
    if (parentPid > 0) {
      IntPtr parent = OpenProcess(SYNCHRONIZE, false, parentPid);
      if (parent == IntPtr.Zero) { StopJob(job); Fail("parent process is gone"); return 3; }
      new Thread(() => { WaitForSingleObject(parent, -1); StopJob(job); Environment.Exit(3); }) { IsBackground = true }.Start();
    }

    var childIn = new FileStream(new SafeFileHandle(inWrite, true), FileAccess.Write);
    var stdout = new Thread(() => Pump(new FileStream(new SafeFileHandle(outRead, true), FileAccess.Read), "stdout")) { IsBackground = true };
    var stderr = new Thread(() => Pump(new FileStream(new SafeFileHandle(errRead, true), FileAccess.Read), "stderr")) { IsBackground = true };
    bool resumed = false;

    new Thread(() => {
      WaitForSingleObject(child.hProcess, -1);
      if (resumed) { stdout.Join(2000); stderr.Join(2000); }
      int code;
      GetExitCodeProcess(child.hProcess, out code);
      uint active = StopJob(job);
      Emit("{\"type\":\"exit\",\"code\":" + code + ",\"activeProcesses\":" + active + "}");
      Environment.Exit(0);
    }) { IsBackground = true }.Start();

    var typePattern = new Regex("\"type\"\\s*:\\s*\"(\\w+)\"");
    var dataPattern = new Regex("\"data\"\\s*:\\s*\"([A-Za-z0-9+/=]*)\"");
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      var type = typePattern.Match(line);
      if (!type.Success) continue;
      switch (type.Groups[1].Value) {
        case "resume":
          if (!resumed) { resumed = true; stdout.Start(); stderr.Start(); ResumeThread(child.hThread); }
          break;
        case "stdin":
          var data = dataPattern.Match(line);
          if (data.Success) { var bytes = Convert.FromBase64String(data.Groups[1].Value); try { childIn.Write(bytes, 0, bytes.Length); childIn.Flush(); } catch (IOException) { } }
          break;
        case "stdin_close":
          try { childIn.Close(); } catch (IOException) { }
          break;
        case "stop":
          uint active = StopJob(job);
          Emit("{\"type\":\"stopped\",\"activeProcesses\":" + active + "}");
          break;
      }
    }
    // The command pipe closed: the bridge is gone, so terminate the tree.
    StopJob(job);
    return 0;
  }

  // Bridge restart recovery: stop any surviving job and verify the child by PID and creation time.
  public static void CheckAndStop(string jobName, int childPid, long childCreatedAt) {
    string jobState = "absent";
    uint active = 0;
    IntPtr job = OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, false, jobName);
    if (job != IntPtr.Zero) { active = StopJob(job); jobState = "stopped"; CloseHandle(job); }
    string childState = "none";
    if (childPid > 0) {
      IntPtr process = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, childPid);
      if (process == IntPtr.Zero) childState = "absent";
      else {
        if (CreatedAt(process) == childCreatedAt) {
          TerminateProcess(process, 1);
          childState = WaitForSingleObject(process, 5000) == 0 ? "terminated" : "alive";
        } else childState = "reused";
        CloseHandle(process);
      }
    }
    Emit("{\"type\":\"check\",\"job\":\"" + jobState + "\",\"activeProcesses\":" + active + ",\"child\":\"" + childState + "\"}");
  }
}
'@

if ($Check) {
  [FaHost]::CheckAndStop($JobName, $ChildPid, $ChildCreatedAt)
  exit 0
}

$specLine = [Console]::In.ReadLine()
if ($null -eq $specLine) { exit 2 }
$spec = $specLine | ConvertFrom-Json
$arguments = [string[]]@($spec.args)
exit [FaHost]::Run([string]$spec.exe, $arguments, [string]$spec.cwd, $JobName, $ParentPid)

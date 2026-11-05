// Based on PR #18144 by Chris van de Steeg; create the child inside the job atomically.
export const WINDOWS_PROCESS_JOB_SOURCE = String.raw`
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class PaperclipProcessJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long User, Kernel, PeriodUser, PeriodKernel; public uint Faults, Total, Active, Terminated;
  }
  [StructLayout(LayoutKind.Sequential)] struct CompletionPort { public IntPtr Key, Port; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint Size; public string Reserved, Desktop, Title; public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedSize; public IntPtr ReservedPtr, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Startup; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr data, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting data, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref StartupEx startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr port, UIntPtr key, uint threads);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetQueuedCompletionStatus(IntPtr port, out uint message, out UIntPtr key, out IntPtr overlapped, uint timeout);

  static void Require(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void SetInfo<T>(IntPtr job, int kind, T value) {
    int size = Marshal.SizeOf(typeof(T)); IntPtr memory = Marshal.AllocHGlobal(size);
    try { Marshal.StructureToPtr(value, memory, false); Require(SetInformationJobObject(job, kind, memory, (uint)size)); }
    finally { Marshal.FreeHGlobal(memory); }
  }
  static string Quote(string value) {
    var result = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      result.Append('\\', slashes * (c == '"' ? 2 : 1)); slashes = 0;
      if (c == '"') result.Append('\\'); result.Append(c);
    }
    result.Append('\\', slashes * 2); return result.Append('"').ToString();
  }
  public static int Main(string[] args) {
    try {
      if (args[0] == "stop") {
        // Cancellation can race the supervisor's first instruction.
        for (int attempt = 0; attempt < 100; attempt++) {
          try { using (var stop = EventWaitHandle.OpenExisting(args[1])) { stop.Set(); return 0; } }
          catch (WaitHandleCannotBeOpenedException) { Thread.Sleep(20); }
        }
        return 1;
      }
      return Run(args);
    } catch (Exception error) { Console.Error.WriteLine("Paperclip process job: " + error.Message); return 1; }
  }
  static int Run(string[] args) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null), port = IntPtr.Zero; ProcessInfo child = new ProcessInfo();
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      var limits = new ExtendedLimit(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE, no breakaway
      SetInfo(job, 9, limits);
      port = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1);
      if (port == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      SetInfo(job, 7, new CompletionPort { Key = new IntPtr(1), Port = port });
      using (var stop = new EventWaitHandle(false, EventResetMode.ManualReset, args[1])) {
        var command = new StringBuilder();
        if (Path.GetFileName(args[4]).Equals("cmd.exe", StringComparison.OrdinalIgnoreCase) && args.Length == 9 &&
            args[5] == "/d" && args[6] == "/s" && args[7] == "/c") {
          command.Append(Quote(args[4])).Append(" /d /s /c \"").Append(args[8]).Append('"');
        } else {
          for (int i = 4; i < args.Length; i++) { if (i > 4) command.Append(' '); command.Append(Quote(args[i])); }
        }
        IntPtr size = IntPtr.Zero, attributes = IntPtr.Zero, jobList = IntPtr.Zero, handles = IntPtr.Zero;
        bool attributesInitialized = false;
        try {
          var stdInput = GetStdHandle(-10); var stdOutput = GetStdHandle(-11); var stdError = GetStdHandle(-12);
          var stdHandles = new List<IntPtr>();
          foreach (IntPtr handle in new[] { stdInput, stdOutput, stdError })
            if (handle != IntPtr.Zero && handle != new IntPtr(-1) && !stdHandles.Contains(handle)) stdHandles.Add(handle);
          int count = stdHandles.Count > 0 ? 2 : 1;
          InitializeProcThreadAttributeList(IntPtr.Zero, count, 0, ref size);
          attributes = Marshal.AllocHGlobal(size);
          Require(InitializeProcThreadAttributeList(attributes, count, 0, ref size));
          attributesInitialized = true;
          jobList = Marshal.AllocHGlobal(IntPtr.Size);
          Marshal.WriteIntPtr(jobList, job);
          Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x0002000d), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
          if (stdHandles.Count > 0) {
            handles = Marshal.AllocHGlobal(IntPtr.Size * stdHandles.Count);
            for (int i = 0; i < stdHandles.Count; i++) Marshal.WriteIntPtr(handles, i * IntPtr.Size, stdHandles[i]);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x00020002), handles, new IntPtr(IntPtr.Size * stdHandles.Count), IntPtr.Zero, IntPtr.Zero));
          }
          var startup = new StartupEx { Attributes = attributes, Startup = new Startup {
            Size = (uint)Marshal.SizeOf(typeof(StartupEx)), Flags = 0x100,
            Input = stdInput, Output = stdOutput, Error = stdError } };
          Require(CreateProcess(args[4], command, IntPtr.Zero, IntPtr.Zero, stdHandles.Count > 0, 0x00080004, IntPtr.Zero, null, ref startup, out child));
        } finally {
          if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
          if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
          if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
          if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
        }
        if (ResumeThread(child.Thread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
        uint result = WaitForMultipleObjects(2, new[] { child.Process, stop.SafeWaitHandle.DangerousGetHandle() }, false, UInt32.MaxValue);
        if (result > 1) throw new Win32Exception(Marshal.GetLastWin32Error());
        uint code = 143;
        if (result == 0) Require(GetExitCodeProcess(child.Process, out code));
        Require(TerminateJobObject(job, code));
        // Kernel completion, not a PID snapshot or the parent's stdio closing.
        uint message; UIntPtr key; IntPtr overlapped;
        do { Require(GetQueuedCompletionStatus(port, out message, out key, out overlapped, 10000)); } while (message != 4);
        Accounting accounting;
        Require(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        if (accounting.Active != 0) throw new InvalidOperationException("Process job has not settled");
        File.WriteAllText(args[2], args[3]);
        return unchecked((int)code);
      }
    } finally {
      // Also covers a failure while the target is suspended inside the job.
      if (child.Process != IntPtr.Zero) { TerminateProcess(child.Process, 1); CloseHandle(child.Process); }
      if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
      CloseHandle(job); if (port != IntPtr.Zero) CloseHandle(port);
    }
  }
}
`;

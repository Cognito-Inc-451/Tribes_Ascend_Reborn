using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace AscendReborn.Launcher
{
    /// <summary>
    /// Runs a command line to completion, streaming every line to the log as it arrives.
    /// Synchronous by design: the launcher calls this from a worker thread.
    /// </summary>
    public static class Runner
    {
        /// <summary>
        /// npm and git are .cmd shims on Windows. cmd.exe resolves them from PATH, which
        /// is the shortest path that works for a double-clicked exe with a plain environment.
        /// </summary>
        public static int Run(string workingDir, string command, Action<string> log)
        {
            return Run(workingDir, command, log, null);
        }

        /// <summary>
        /// pathExtra prepends folders to the child's PATH - a tool installed mid-run
        /// (Node's MSI, Git's winget package) is not in this process's environment yet.
        /// </summary>
        public static int Run(string workingDir, string command, Action<string> log, string pathExtra)
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = "cmd.exe";
            psi.Arguments = "/d /c " + command;
            psi.WorkingDirectory = workingDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            ApplyPathExtra(psi, pathExtra);

            using (Process p = Process.Start(psi))
            {
                // Drain both pipes on their own threads so a chatty tool never deadlocks.
                OutputDrainer outDrain = new OutputDrainer(p.StandardOutput, log);
                OutputDrainer errDrain = new OutputDrainer(p.StandardError, log);
                outDrain.Start();
                errDrain.Start();
                int code;
                p.WaitForExit();
                code = p.ExitCode;
                outDrain.Join();
                errDrain.Join();
                return code;
            }
        }

        /// <summary>Launches a detached, visible console window (the game / server host).</summary>
        public static void StartDetached(string workingDir, string command)
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = "cmd.exe";
            psi.Arguments = "/d /k title Ascend Reborn && " + command;
            psi.WorkingDirectory = workingDir;
            psi.UseShellExecute = true;
            psi.WindowStyle = ProcessWindowStyle.Normal;
            Process.Start(psi);
        }

        public static string Capture(string workingDir, string command)
        {
            return Capture(workingDir, command, null);
        }

        public static string Capture(string workingDir, string command, string pathExtra)
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = "cmd.exe";
            psi.Arguments = "/d /c " + command;
            psi.WorkingDirectory = workingDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            ApplyPathExtra(psi, pathExtra);

            using (Process p = Process.Start(psi))
            {
                string text = p.StandardOutput.ReadToEnd();
                p.WaitForExit();
                return text.Trim();
            }
        }

        public static bool CommandExists(string executable)
        {
            return CommandExists(executable, null);
        }

        public static bool CommandExists(string executable, string pathExtra)
        {
            try
            {
                string text = Capture(Environment.SystemDirectory, "where " + executable + " 2>nul", pathExtra);
                return text.Length > 0;
            }
            catch { return false; }
        }

        /// <summary>
        /// Machine + user PATH re-read from the registry, so a tool installed moments ago
        /// by this same launcher run is visible without asking the player to restart.
        /// </summary>
        public static string RefreshPath()
        {
            string machine = ReadRegistryPath(Microsoft.Win32.RegistryHive.LocalMachine,
                "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment");
            string user = ReadRegistryPath(Microsoft.Win32.RegistryHive.CurrentUser, "Environment");
            string current = Environment.GetEnvironmentVariable("PATH") ?? "";
            System.Text.StringBuilder sb = new System.Text.StringBuilder();
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string entry in new string[] { machine, user, current })
            {
                if (string.IsNullOrEmpty(entry)) continue;
                foreach (string raw in entry.Split(';'))
                {
                    string folder = raw.Trim();
                    if (folder.Length == 0) continue;
                    if (!seen.Add(folder)) continue;
                    sb.Append(';').Append(folder);
                }
            }
            string result = sb.ToString();
            return result.StartsWith(";") ? result.Substring(1) : result;
        }

        private static string ReadRegistryPath(Microsoft.Win32.RegistryHive hive, string key)
        {
            try
            {
                using (Microsoft.Win32.RegistryKey root = Microsoft.Win32.RegistryKey.OpenBaseKey(hive, Microsoft.Win32.RegistryView.Default))
                using (Microsoft.Win32.RegistryKey k = root.OpenSubKey(key))
                {
                    if (k == null) return "";
                    object val = k.GetValue("Path");
                    return val == null ? "" : val.ToString();
                }
            }
            catch { return ""; }
        }

        private static void ApplyPathExtra(ProcessStartInfo psi, string pathExtra)
        {
            if (string.IsNullOrEmpty(pathExtra)) return;
            string current = Environment.GetEnvironmentVariable("PATH") ?? "";
            psi.EnvironmentVariables["PATH"] = pathExtra + ";" + current;
        }
    }

    internal sealed class OutputDrainer
    {
        private readonly StreamReader _reader;
        private readonly Action<string> _log;
        private System.Threading.Thread _thread;

        public OutputDrainer(StreamReader reader, Action<string> log)
        {
            _reader = reader;
            _log = log;
        }

        public void Start()
        {
            _thread = new System.Threading.Thread(Drain);
            _thread.IsBackground = true;
            _thread.Start();
        }

        public void Join()
        {
            if (_thread != null) _thread.Join();
        }

        private void Drain()
        {
            string line;
            while ((line = _reader.ReadLine()) != null)
            {
                if (_log != null) _log(line);
            }
        }
    }
}

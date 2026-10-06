using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Windows.Forms;

namespace AscendReborn.Launcher
{
    /// <summary>
    /// Automates the README "Quick Start" steps: Node, Git, clone, npm install,
    /// Tribes: Ascend asset import. Every method logs and returns success.
    /// </summary>
    public static class Setup
    {
        /// <summary>
        /// Folders to prepend to every child process PATH. The one-click Install sets this
        /// after installing Node/Git, since a fresh install is not in this process's
        /// environment and the player should not have to relaunch the launcher.
        /// </summary>
        public static string PathExtra = null;

        private static void Log(Action<string> log, string message)
        {
            if (log != null) log(message);
        }

        // --- Toolchain -------------------------------------------------------

        public static bool NodeInstalled(Action<string> log)
        {
            if (!Runner.CommandExists("node", PathExtra)) return false;
            Log(log, "node " + Runner.Capture(Environment.SystemDirectory, "node --version", PathExtra));
            Log(log, "npm  " + Runner.Capture(Environment.SystemDirectory, "npm --version", PathExtra));
            return true;
        }

        public static bool GitInstalled(Action<string> log)
        {
            if (!Runner.CommandExists("git", PathExtra)) return false;
            Log(log, Runner.Capture(Environment.SystemDirectory, "git --version", PathExtra));
            return true;
        }

        /// <summary>
        /// Installs Git through winget (the command the README documents). Falls back to
        /// opening the download page when winget is unavailable.
        /// </summary>
        public static bool InstallGit(Action<string> log)
        {
            if (!Runner.CommandExists("winget"))
            {
                Log(log, "winget is not available - opening the Git download page.");
                OpenUrl("https://git-scm.com/download/win");
                return false;
            }
            Log(log, "winget install --id Git.Git -e --source winget");
            int code = Runner.Run(Environment.SystemDirectory,
                "winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements", log, PathExtra);
            Log(log, "winget exit code " + code);
            return code == 0 && GitInstalled(log);
        }

        /// <summary>
        /// Installs the Node LTS the Quick Start recommends. Runs the official MSI
        /// silently from a temp download; the player can cancel the UAC prompt.
        /// </summary>
        public static bool InstallNode(Action<string> log)
        {
            string tmp = Path.Combine(Path.GetTempPath(), "ascend-node.msi");
            try
            {
                Log(log, "downloading " + AppInfo.NodeMsiUrl);
                using (WebClient wc = new WebClient()) wc.DownloadFile(AppInfo.NodeMsiUrl, tmp);
            }
            catch (Exception ex)
            {
                Log(log, "download failed: " + ex.Message);
                OpenUrl(AppInfo.NodeMsiUrl);
                return false;
            }

            Log(log, "installing Node (accept the UAC prompt)...");
            int code = Runner.Run(Path.GetTempPath(),
                "msiexec /i \"" + tmp + "\" /qb", log, PathExtra);
            Log(log, "msiexec exit code " + code);
            try { File.Delete(tmp); } catch { }

            // A fresh MSI install is not on this process's PATH, so probe the folder.
            if (NodeInstalled(log)) return true;
            Log(log, "Node installed - start a new command prompt (or relaunch this launcher) to pick it up.");
            return code == 0;
        }

        // --- Clone -----------------------------------------------------------

        public static bool Clone(string targetParent, Action<string> log)
        {
            string dest = Path.Combine(targetParent, AppInfo.Repo);
            if (Directory.Exists(Path.Combine(dest, ".git")))
            {
                Log(log, "already cloned: " + dest);
                return true;
            }
            Log(log, "git clone " + AppInfo.CloneUrl);
            Log(log, "into " + targetParent);
            int code = Runner.Run(targetParent, "git clone " + AppInfo.CloneUrl, log, PathExtra);
            Log(log, "clone exit code " + code);
            return code == 0 && Directory.Exists(dest);
        }

        public static bool Pull(string repoRoot, Action<string> log)
        {
            Log(log, "git pull --ff-only");
            int code = Runner.Run(repoRoot, "git pull --ff-only", log, PathExtra);
            Log(log, "pull exit code " + code);
            return code == 0;
        }

        // --- Dependencies ----------------------------------------------------

        public static bool NpmInstall(string repoRoot, Action<string> log)
        {
            Log(log, "npm install (this pulls the workspaces - a few minutes)");
            int code = Runner.Run(repoRoot, "npm install --no-audit --no-fund", log, PathExtra);
            Log(log, "npm install exit code " + code);
            return code == 0;
        }

        // --- Game assets -----------------------------------------------------

        /// <summary>Folders that plausibly hold a Tribes: Ascend install.</summary>
        public static string FindTaInstall()
        {
            string[] roots = new string[]
            {
                @"C:\Program Files (x86)\Steam\steamapps\common\Tribes Ascend",
                @"C:\Program Files\Steam\steamapps\common\Tribes Ascend",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Tribes Ascend"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Tribes Ascend"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads"),
            };
            foreach (string root in roots)
            {
                if (HasCookedData(root)) return root;
            }
            return "";
        }

        public static bool HasCookedData(string installRoot)
        {
            if (string.IsNullOrEmpty(installRoot)) return false;
            return Directory.Exists(Path.Combine(installRoot, "TribesGame", "CookedPC"));
        }

        /// <summary>True when the importer has already produced the game's asset folder.</summary>
        public static bool HasImport(string repoRoot)
        {
            try
            {
                string dir = Path.Combine(repoRoot, "maps-original");
                if (!Directory.Exists(dir)) return false;
                return Directory.GetFileSystemEntries(dir, "*", SearchOption.AllDirectories).Length > 0;
            }
            catch { return false; }
        }

        /// <summary>
        /// Imports the player's own Tribes: Ascend data. When the game is already
        /// installed the importer only needs the --all sweep; otherwise it runs the
        /// guided installer against the folder we found.
        /// </summary>
        public static bool ImportAssets(string repoRoot, string taInstall, Action<string> log)
        {
            if (HasImport(repoRoot))
            {
                Log(log, "maps-original already present - re-running the importer to catch new content.");
            }

            if (HasCookedData(taInstall))
            {
                Log(log, "importing from " + taInstall + " (long-running, several GB)");
                int importCode = Runner.Run(repoRoot, "npm run ta-import -- --all --install \"" + taInstall + "\"", log, PathExtra);
                Log(log, "import exit code " + importCode);
                return importCode == 0;
            }

            Log(log, "Tribes: Ascend data not found in the usual places.");
            Log(log, "Pick the folder containing TribesGame\\CookedPC when the importer asks.");
            int taCode = Runner.Run(repoRoot, "npm run install-ta", log, PathExtra);
            Log(log, "install-ta exit code " + taCode);
            return taCode == 0;
        }

        // --- Launch ----------------------------------------------------------

        public static void LaunchWithServers(string repoRoot)
        {
            Runner.StartDetached(repoRoot, "npm start");
        }

        public static void LaunchClientOnly(string repoRoot)
        {
            Runner.StartDetached(repoRoot, "npm run play");
        }

        public static void OpenGame()
        {
            OpenUrl(AppInfo.GameUrl);
        }

        public static void OpenRepo()
        {
            OpenUrl(AppInfo.RepoUrl);
        }

        public static void OpenUrl(string url)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(url);
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
            catch { }
        }

        /// <summary>
        /// Closes the game / server consoles this launcher started. Each detached console
        /// registers as a conhost-owned window process; we ask cmd.exe to kill the npm
        /// tree it owns, then close any console titled for the game.
        /// </summary>
        public static void CloseServers(Action<string> log)
        {
            Log(log, "closing Ascend Reborn consoles...");
            // Only the consoles this launcher opened (they carry the title set by /k title),
            // plus their whole child tree so the node processes they spawned go with them.
            Runner.Run(Environment.SystemDirectory,
                "taskkill /f /t /fi \"WINDOWTITLE eq Ascend Reborn*\" 2>nul", log);
            Log(log, "done. (Any server you started by hand is still running.)");
        }

        // --- Self update -----------------------------------------------------

        /// <summary>
        /// Downloads the launcher asset from the latest release and swaps it in. The
        /// replacement is staged next to the running exe and copied on the next start,
        /// because a running exe cannot overwrite itself.
        /// </summary>
        public static bool UpdateLauncher(string launcherAssetUrl, Action<string> log)
        {
            if (string.IsNullOrEmpty(launcherAssetUrl)) return false;
            string dir = AppInfo.ExeDirectory;
            string self = System.Windows.Forms.Application.ExecutablePath;
            string staged = Path.Combine(dir, "AscendRebornLauncher.new.exe");
            try
            {
                Log(log, "downloading the new launcher...");
                using (WebClient wc = new WebClient()) wc.DownloadFile(launcherAssetUrl, staged);
                File.WriteAllText(Path.Combine(dir, "APPLY-UPDATE.cmd"),
                    "@echo off\r\n" +
                    "timeout /t 2 /nobreak >nul\r\n" +
                    "copy /y \"%~dp0AscendRebornLauncher.new.exe\" \"" + self + "\" >nul\r\n" +
                    "del \"%~dp0AscendRebornLauncher.new.exe\"\r\n" +
                    "del \"%~dp0APPLY-UPDATE.cmd\"\r\n" +
                    "start \"\" \"" + self + "\"\r\n");
                Log(log, "the new launcher is staged - closing this one to finish the update.");
                return true;
            }
            catch (Exception ex)
            {
                Log(log, "launcher update failed: " + ex.Message);
                return false;
            }
        }
    }
}

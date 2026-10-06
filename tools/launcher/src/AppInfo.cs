using System;
using System.Collections.Generic;
using System.IO;

namespace AscendReborn.Launcher
{
    /// <summary>Fixed addresses, well-known paths and the small settings file.</summary>
    public static class AppInfo
    {
        public const string Owner = "Cognito-Inc-451";
        public const string Repo = "Tribes_Ascend_Reborn";
        public const string RepoUrl = "https://github.com/" + Owner + "/" + Repo;
        public const string CloneUrl = RepoUrl + ".git";
        public const string GameUrl = "http://localhost:7770";
        public const string UserAgent = "ascend-reborn-launcher";

        /// <summary>Node build the Quick Start guide recommends (README, Windows section).</summary>
        public const string NodeMsiUrl = "https://nodejs.org/dist/v24.21.0/node-v24.21.0-x64.msi";

        public static string SettingsDir
        {
            get
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "AscendReborn");
            }
        }

        private static string SettingsFile
        {
            get { return Path.Combine(SettingsDir, "launcher.cfg"); }
        }

        /// <summary>Where the player asked the game to live (blank = never chosen).</summary>
        public static string TargetFolder = "";

        public static void Load()
        {
            try
            {
                if (!File.Exists(SettingsFile)) return;
                foreach (string raw in File.ReadAllLines(SettingsFile))
                {
                    int eq = raw.IndexOf('=');
                    if (eq <= 0) continue;
                    string key = raw.Substring(0, eq).Trim();
                    string val = raw.Substring(eq + 1).Trim();
                    if (key == "target") TargetFolder = val;
                }
            }
            catch
            {
                // A damaged settings file must never stop the launcher from starting.
            }
        }

        public static void Save()
        {
            try
            {
                Directory.CreateDirectory(SettingsDir);
                File.WriteAllText(SettingsFile, "target=" + TargetFolder + Environment.NewLine);
            }
            catch
            {
                // Settings are a convenience; failing to persist them is not fatal.
            }
        }

        /// <summary>Folder the running exe lives in (players save it anywhere).</summary>
        public static string ExeDirectory
        {
            get
            {
                try { return Path.GetDirectoryName(System.Windows.Forms.Application.ExecutablePath); }
                catch { return ""; }
            }
        }

        /// <summary>
        /// Candidate folders that could hold the clone: the saved choice, every folder from
        /// the exe up to the drive root (a launcher saved inside the clone finds it right
        /// away), and the usual download spots.
        /// </summary>
        public static List<string> CandidateFolders()
        {
            List<string> list = new List<string>();
            if (TargetFolder.Length > 0) list.Add(TargetFolder);
            AddWithAncestors(list, ExeDirectory, 8);
            list.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads"));
            list.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Games"));

            List<string> clean = new List<string>();
            foreach (string p in list)
            {
                if (string.IsNullOrEmpty(p)) continue;
                if (!clean.Contains(p)) clean.Add(p);
            }
            return clean;
        }

        /// <summary>Adds a folder and each of its parents, closest first.</summary>
        private static void AddWithAncestors(List<string> list, string folder, int maxDepth)
        {
            string current = folder;
            for (int depth = 0; depth < maxDepth && !string.IsNullOrEmpty(current); depth++)
            {
                list.Add(current);
                try { current = Path.GetDirectoryName(current); }
                catch { current = null; }
            }
        }
    }
}

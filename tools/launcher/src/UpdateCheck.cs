using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace AscendReborn.Launcher
{
    public class UpdateInfo
    {
        public bool Checked;
        public bool Online;
        public bool NoRelease;
        public bool UpToDate;
        public string LocalVersion = "";
        public string RemoteTag = "";
        public string ReleaseUrl = "";
        public string LauncherAssetUrl = "";
        public string Notes = "";
        public int CommitsBehind;
        public string Message = "";
    }

    /// <summary>
    /// GitHub checks for the release flow: newest release tag vs the clone's package.json
    /// version, plus how many commits the clone is behind origin/main.
    ///
    /// The repository has no CI, so the update check talks to the GitHub REST API
    /// directly - no gh CLI, no SDK.
    /// </summary>
    public static class UpdateCheck
    {
        private const string ApiRoot = "https://api.github.com/repos/" + AppInfo.Owner + "/" + AppInfo.Repo;

        public static UpdateInfo Run(string repoRoot, Action<string> log)
        {
            UpdateInfo info = new UpdateInfo();
            info.LocalVersion = LocalVersion(repoRoot);

            // 1. Newest published release.
            try
            {
                string json = Get(ApiRoot + "/releases/latest");
                info.Online = true;
                info.RemoteTag = JsonString(json, "tag_name");
                info.ReleaseUrl = JsonString(json, "html_url");
                info.Notes = JsonString(json, "body");
                info.LauncherAssetUrl = LauncherAsset(json);
            }
            catch (WebException ex)
            {
                // GitHub answers 404 when the repo simply has no published release yet -
                // that is a normal state, not a connectivity problem.
                HttpWebResponse res = ex.Response as HttpWebResponse;
                if (res != null && res.StatusCode == HttpStatusCode.NotFound)
                {
                    info.Online = true;
                    info.NoRelease = true;
                    if (log != null) log("GitHub is reachable - no release has been published yet.");
                }
                else
                {
                    if (log != null) log("release check failed: " + ex.Message);
                }
            }
            catch (Exception ex)
            {
                if (log != null) log("release check failed: " + ex.Message);
            }

            // 2. How far behind origin/main the clone is (source updates are a git pull).
            if (Directory.Exists(Path.Combine(repoRoot, ".git")))
            {
                try
                {
                    Runner.Run(repoRoot, "git fetch origin main --quiet", null);
                    string counts = Runner.Capture(repoRoot, "git rev-list --left-right --count origin/main...HEAD");
                    string[] parts = counts.Split(new char[] { '\t', ' ' }, StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length >= 2)
                    {
                        int behind;
                        if (int.TryParse(parts[0], out behind)) info.CommitsBehind = behind;
                    }
                }
                catch (Exception ex)
                {
                    if (log != null) log("git check failed: " + ex.Message);
                }
            }

            info.Checked = true;
            info.UpToDate = info.CommitsBehind <= 0 && !IsNewerTag(info.RemoteTag, info.LocalVersion);
            info.Message = Describe(info);
            if (log != null) log(info.Message);
            return info;
        }

        /// <summary>Version declared by the clone's root package.json.</summary>
        public static string LocalVersion(string repoRoot)
        {
            try
            {
                string file = Path.Combine(repoRoot, "package.json");
                if (!File.Exists(file)) return "";
                return JsonString(File.ReadAllText(file), "version");
            }
            catch { return ""; }
        }

        private static string Describe(UpdateInfo info)
        {
            if (!info.Online) return "Could not reach GitHub (offline?).";
            List<string> bits = new List<string>();
            if (IsNewerTag(info.RemoteTag, info.LocalVersion))
                bits.Add("release " + info.RemoteTag + " is out (you have " + info.LocalVersion + ")");
            if (info.CommitsBehind > 0)
                bits.Add(info.CommitsBehind + " commit(s) behind main");
            if (bits.Count == 0)
                bits.Add(info.NoRelease
                    ? "up to date (v" + info.LocalVersion + ") - no release published yet"
                    : "up to date (v" + info.LocalVersion + ")");
            return string.Join(" - ", bits.ToArray());
        }

        /// <summary>True when the release tag is a later version than the local one.</summary>
        private static bool IsNewerTag(string tag, string local)
        {
            int[] a = ParseVersion(tag);
            int[] b = ParseVersion(local);
            if (a == null || b == null) return false;
            int n = Math.Max(a.Length, b.Length);
            for (int i = 0; i < n; i++)
            {
                int x = i < a.Length ? a[i] : 0;
                int y = i < b.Length ? b[i] : 0;
                if (x != y) return x > y;
            }
            return false;
        }

        private static int[] ParseVersion(string text)
        {
            if (string.IsNullOrEmpty(text)) return null;
            Match m = Regex.Match(text, @"(\d+)\.(\d+)\.(\d+)");
            if (!m.Success) return null;
            return new int[]
            {
                int.Parse(m.Groups[1].Value),
                int.Parse(m.Groups[2].Value),
                int.Parse(m.Groups[3].Value)
            };
        }

        /// <summary>Direct download for the launcher asset on the latest release, if published.</summary>
        private static string LauncherAsset(string json)
        {
            Match m = Regex.Match(json, "\"name\"\\s*:\\s*\"(?<n>[^\"]*(?i:launcher)[^\"]*\\.exe)\"");
            if (!m.Success) return "";
            int at = IndexOf(json, "browser_download_url", m.Index);
            if (at < 0) return "";
            return JsonString(json.Substring(at), "browser_download_url");
        }

        private static int IndexOf(string haystack, string needle, int from)
        {
            return haystack.IndexOf(needle, from, StringComparison.OrdinalIgnoreCase);
        }

        private static string Get(string url)
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.UserAgent = AppInfo.UserAgent;
            req.Accept = "application/vnd.github+json";
            req.Timeout = 12000;
            req.ReadWriteTimeout = 12000;
            using (WebResponse res = req.GetResponse())
            using (Stream s = res.GetResponseStream())
            using (StreamReader r = new StreamReader(s, Encoding.UTF8))
            {
                return r.ReadToEnd();
            }
        }

        /// <summary>Minimal JSON field reader - enough for the flat fields we need.</summary>
        private static string JsonString(string json, string key)
        {
            Match m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            if (!m.Success) return "";
            return Unescape(m.Groups[1].Value);
        }

        private static string Unescape(string text)
        {
            StringBuilder sb = new StringBuilder(text.Length);
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (c != '\\' || i + 1 >= text.Length) { sb.Append(c); continue; }
                char n = text[++i];
                if (n == 'n') sb.Append('\n');
                else if (n == 'r') sb.Append('\r');
                else if (n == 't') sb.Append('\t');
                else if (n == 'u' && i + 4 < text.Length)
                {
                    int code;
                    if (int.TryParse(text.Substring(i + 1, 4),
                        System.Globalization.NumberStyles.HexNumber, null, out code))
                    {
                        sb.Append((char)code);
                        i += 4;
                    }
                    else sb.Append(n);
                }
                else sb.Append(n);
            }
            return sb.ToString();
        }
    }
}

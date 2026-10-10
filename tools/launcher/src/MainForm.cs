using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace AscendReborn.Launcher
{
    /// <summary>
    /// One window for the whole Quick Start: install the toolchain, get the game,
    /// import the assets, play, and stay updated. Every long step runs on a worker
    /// thread and streams its output into the log panel.
    /// </summary>
    public sealed class MainForm : Form
    {
        private readonly TextBox _log;
        private readonly Label _status;
        private readonly Label _version;
        private readonly PictureBox _banner;
        private readonly Panel _body;

        private readonly Button _btnInstall;
        private readonly Button _btnNode;
        private readonly Button _btnGit;
        private readonly Button _btnClone;
        private readonly Button _btnDeps;
        private readonly Button _btnImport;
        private readonly Button _btnPlay;
        private readonly Button _btnPlaySolo;
        private readonly Button _btnOpen;
        private readonly Button _btnClose;
        private readonly Button _btnCheck;
        private readonly Button _btnUpdate;
        private readonly Button _btnSelfUpdate;
        private readonly Button _btnPick;

        private UpdateInfo _update;
        private string _repoRoot = "";
        private volatile bool _busy;
        private volatile bool _checking;
        private bool _importHintShown;

        public MainForm()
        {
            AppInfo.Load();

            Text = "Ascend Reborn";
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(940, 760);
            MinimumSize = new Size(820, 680);
            BackColor = Theme.Bg;
            DoubleBuffered = true;
            Font = Theme.Ui;
            ApplyIcon();

            _banner = new PictureBox();
            _banner.SetBounds(16, 14, 908, 96);
            _banner.SizeMode = PictureBoxSizeMode.StretchImage;
            Controls.Add(_banner);

            _version = Theme.MakeLabel("", false);
            _version.SetBounds(16, 116, 560, 22);
            _version.Font = Theme.UiSection;
            _version.ForeColor = Theme.Accent;
            Controls.Add(_version);

            _status = Theme.MakeLabel("Checking GitHub...", false);
            _status.SetBounds(16, 140, 908, 22);
            _status.ForeColor = Theme.TextDim;
            Controls.Add(_status);

            _body = new Panel();
            _body.SetBounds(16, 170, 908, 560);
            _body.BackColor = Theme.Bg;
            Controls.Add(_body);

            // --- Setup column -------------------------------------------------
            Label setup = Theme.MakeLabel("1. Set up", false);
            setup.SetBounds(0, 0, 300, 22);
            setup.Font = Theme.UiSection;
            setup.ForeColor = Theme.Accent;
            _body.Controls.Add(setup);

            // One button does the whole Quick Start: toolchain, clone, dependencies, import.
            _btnInstall = Theme.MakeButton("Install");
            _btnInstall.SetBounds(0, 28, 298, 44);
            _btnInstall.BackColor = Theme.Ok;
            _btnInstall.Font = Theme.UiSection;
            _btnInstall.Click += delegate { InstallEverything(); };
            _body.Controls.Add(_btnInstall);

            _btnPick = Theme.MakeButton("Choose game folder...");
            _btnPick.SetBounds(0, 80, 298, 30);
            _btnPick.Click += delegate { PickFolder(); };
            _body.Controls.Add(_btnPick);

            _btnClone = Theme.MakeButton("Download the game");
            _btnClone.SetBounds(0, 116, 298, 30);
            _btnClone.Click += delegate { Step("Clone", delegate(Action<string> log)
            {
                string parent = TargetParent();
                if (Setup.Clone(parent, log))
                {
                    AppInfo.TargetFolder = parent;
                    AppInfo.Save();
                }
            }); };
            _body.Controls.Add(_btnClone);

            _btnDeps = Theme.MakeButton("Install dependencies");
            _btnDeps.SetBounds(0, 152, 298, 30);
            _btnDeps.Click += delegate { Step("Dependencies", delegate(Action<string> log) { RequireRepo(delegate(string r, Action<string> l) { Setup.NpmInstall(r, l); }); }); };
            _body.Controls.Add(_btnDeps);

            _btnImport = Theme.MakeButton("Import Tribes: Ascend assets");
            _btnImport.SetBounds(0, 188, 298, 30);
            _btnImport.Click += delegate { Step("Asset import", delegate(Action<string> log)
            {
                RequireRepo(delegate(string r, Action<string> l)
                {
                    string ta = Setup.FindTaInstall();
                    if (ta.Length > 0) Log("found Tribes: Ascend data at " + ta);
                    Setup.ImportAssets(r, ta, log);
                });
            }); };
            _body.Controls.Add(_btnImport);

            // Single-step toolchain installs, kept under the one-click Install as
            // "advanced" helpers for players who only need one of them.
            Label advanced = Theme.MakeLabel("Setup, one step at a time", false);
            advanced.SetBounds(0, 226, 298, 18);
            advanced.Font = Theme.UiSmall;
            advanced.ForeColor = Theme.TextDim;
            _body.Controls.Add(advanced);

            _btnNode = Theme.MakeButton("Install Node.js");
            _btnNode.SetBounds(0, 246, 145, 28);
            _btnNode.Click += delegate { Step("Node.js", delegate(Action<string> log) { Setup.InstallNode(log); }); };
            _body.Controls.Add(_btnNode);

            _btnGit = Theme.MakeButton("Install Git");
            _btnGit.SetBounds(153, 246, 145, 28);
            _btnGit.Click += delegate { Step("Git", delegate(Action<string> log) { Setup.InstallGit(log); }); };
            _body.Controls.Add(_btnGit);

            // --- Play column --------------------------------------------------
            Label play = Theme.MakeLabel("2. Play", false);
            play.SetBounds(0, 292, 300, 22);
            play.Font = Theme.UiSection;
            play.ForeColor = Theme.Accent;
            _body.Controls.Add(play);

            _btnPlay = Theme.MakeButton("Start game (server)");
            _btnPlay.SetBounds(0, 320, 298, 34);
            _btnPlay.BackColor = Theme.Ok;
            _btnPlay.Click += delegate { Play(true); };
            _body.Controls.Add(_btnPlay);

            _btnPlaySolo = Theme.MakeButton("Start game (client)");
            _btnPlaySolo.SetBounds(0, 360, 298, 32);
            _btnPlaySolo.Click += delegate { Play(false); };
            _body.Controls.Add(_btnPlaySolo);

            _btnOpen = Theme.MakeButton("Open browser");
            _btnOpen.SetBounds(0, 398, 145, 32);
            _btnOpen.Click += delegate { Setup.OpenGame(); };
            _body.Controls.Add(_btnOpen);

            _btnClose = Theme.MakeButton("Stop servers");
            _btnClose.SetBounds(153, 398, 145, 32);
            _btnClose.Click += delegate { Step("Stop servers", delegate(Action<string> log) { Setup.CloseServers(log); }); };
            _body.Controls.Add(_btnClose);

            // --- Update column ------------------------------------------------
            Label update = Theme.MakeLabel("3. Keep it current", false);
            update.SetBounds(0, 450, 300, 22);
            update.Font = Theme.UiSection;
            update.ForeColor = Theme.Accent;
            _body.Controls.Add(update);

            _btnCheck = Theme.MakeButton("Check for updates");
            _btnCheck.SetBounds(0, 478, 145, 32);
            _btnCheck.Click += delegate { CheckForUpdates(); };
            _body.Controls.Add(_btnCheck);

            // Update = pull + dependencies + re-import, in that order.
            _btnUpdate = Theme.MakeButton("Update the game");
            _btnUpdate.SetBounds(153, 478, 145, 32);
            _btnUpdate.Click += delegate { Step("Update", delegate(Action<string> log)
            {
                RequireRepo(delegate(string r, Action<string> l)
                {
                    Setup.Pull(r, l);
                    Setup.NpmInstall(r, l);
                    Setup.ImportAssets(r, Setup.FindTaInstall(), l);
                });
            }); };
            _body.Controls.Add(_btnUpdate);

            _btnSelfUpdate = Theme.MakeButton("Update this launcher");
            _btnSelfUpdate.SetBounds(0, 516, 298, 30);
            _btnSelfUpdate.Click += delegate { SelfUpdate(); };
            _body.Controls.Add(_btnSelfUpdate);

            // --- Log console --------------------------------------------------
            Label logLabel = Theme.MakeLabel("Log", false);
            logLabel.SetBounds(320, 0, 300, 22);
            logLabel.Font = Theme.UiSection;
            logLabel.ForeColor = Theme.Accent;
            _body.Controls.Add(logLabel);

            _log = new TextBox();
            _log.SetBounds(320, 28, 588, 492);
            _log.Multiline = true;
            _log.ReadOnly = true;
            _log.ScrollBars = ScrollBars.Vertical;
            _log.BackColor = Theme.LogBg;
            _log.ForeColor = Theme.Text;
            _log.Font = Theme.Mono;
            _log.WordWrap = false;
            _body.Controls.Add(_log);

            LinkLabel link = new LinkLabel();
            link.Text = "github.com/" + AppInfo.Owner + "/" + AppInfo.Repo;
            link.SetBounds(320, 528, 300, 22);
            link.LinkColor = Theme.Accent;
            link.ActiveLinkColor = Theme.Ok;
            link.LinkVisited = false;
            link.VisitedLinkColor = Theme.AccentDim;
            link.Font = Theme.UiSmall;
            link.LinkClicked += delegate { Setup.OpenRepo(); };
            _body.Controls.Add(link);

            RefreshRepoState();
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            BeginCheck();
        }

        // --- Painting -------------------------------------------------------

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            Rectangle banner = new Rectangle(12, 10, 916, 104);
            using (GraphicsPath p = Theme.RoundRect(banner, 10))
            using (SolidBrush b = new SolidBrush(Theme.PanelDark))
                g.FillPath(b, p);
            using (GraphicsPath p = Theme.RoundRect(new Rectangle(12, 168, 306, 556), 10))
            using (Pen pen = new Pen(Theme.AccentDim, 1f)) g.DrawPath(pen, p);
            using (GraphicsPath p = Theme.RoundRect(new Rectangle(328, 168, 600, 556), 10))
            using (Pen pen = new Pen(Theme.AccentDim, 1f)) g.DrawPath(pen, p);
        }

        // --- Logging --------------------------------------------------------

        private void Log(string line)
        {
            if (InvokeRequired)
            {
                BeginInvoke(new Action<string>(Log), line);
                return;
            }
            if (_log.TextLength > 220000) _log.Clear();
            _log.AppendText(line + Environment.NewLine);
            _log.SelectionStart = _log.TextLength;
            _log.ScrollToCaret();
        }

        // --- Worker plumbing -------------------------------------------------

        private delegate void Work(Action<string> log);

        private void Step(string title, Work work)
        {
            if (_busy) return;
            _busy = true;
            SetButtonsEnabled(false);
            RunStep(title, work, true);
        }

        /// <summary>
        /// Runs a step without touching the buttons. Used by the update check: it is pure
        /// information, so a slow GitHub/git round trip must never leave the player staring
        /// at a window of dead buttons - the install and play buttons stay live throughout.
        /// </summary>
        private void StepAdvisory(string title, Work work)
        {
            if (_checking) return;
            _checking = true;
            RunStep(title, work, false);
        }

        private void RunStep(string title, Work work, bool blocking)
        {
            Log("");
            Log("=== " + title + " ===");
            Thread thread = new Thread(delegate()
            {
                bool ok = true;
                try { work(Log); }
                catch (Exception ex) { ok = false; Log("!! " + ex.Message); }
                Log(ok ? "=== " + title + " done ===" : "=== " + title + " failed ===");
                if (blocking) _busy = false;
                else _checking = false;
                try
                {
                    BeginInvoke(new Action(delegate
                    {
                        if (blocking) SetButtonsEnabled(true);
                        RefreshRepoState();
                    }));
                }
                catch { }
            });
            thread.IsBackground = true;
            thread.Start();
        }

        private delegate void RepoWork(string repoRoot, Action<string> log);

        private void RequireRepo(RepoWork work)
        {
            string root = DetectRepo();
            if (root.Length == 0)
            {
                Log("No Ascend Reborn folder found - use \"Download the game\" first.");
                return;
            }
            _repoRoot = root;
            work(root, Log);
        }

        private void SetButtonsEnabled(bool enabled)
        {
            Button[] all = new Button[]
            {
                _btnInstall, _btnNode, _btnGit, _btnPick, _btnClone, _btnDeps, _btnImport,
                _btnPlay, _btnPlaySolo, _btnOpen, _btnClose,
                _btnCheck, _btnUpdate, _btnSelfUpdate
            };
            foreach (Button b in all) b.Enabled = enabled;
        }

        // --- State ----------------------------------------------------------

        private string DetectRepo()
        {
            foreach (string candidate in AppInfo.CandidateFolders())
            {
                string direct = candidate;
                if (IsRepo(direct)) return direct;
                string nested = Path.Combine(candidate, AppInfo.Repo);
                if (IsRepo(nested)) return nested;
            }
            return "";
        }

        private static bool IsRepo(string folder)
        {
            if (string.IsNullOrEmpty(folder)) return false;
            try { return Directory.Exists(Path.Combine(folder, ".git")); }
            catch { return false; }
        }

        private string TargetParent()
        {
            if (AppInfo.TargetFolder.Length > 0) return AppInfo.TargetFolder;
            string exe = AppInfo.ExeDirectory;
            if (!string.IsNullOrEmpty(exe)) return Path.GetDirectoryName(exe);
            return Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        }

        private void PickFolder()
        {
            using (FolderBrowserDialog dlg = new FolderBrowserDialog())
            {
                dlg.Description = "Where should Ascend Reborn live?";
                string suggested = TargetParent();
                if (Directory.Exists(suggested)) dlg.SelectedPath = suggested;
                if (dlg.ShowDialog(this) != DialogResult.OK) return;
                AppInfo.TargetFolder = dlg.SelectedPath;
                AppInfo.Save();
                Log("game folder set to " + dlg.SelectedPath);
                RefreshRepoState();
            }
        }

        private void RefreshRepoState()
        {
            string root = DetectRepo();
            _repoRoot = root;
            if (root.Length == 0)
            {
                _version.Text = "Ascend Reborn - not installed yet";
                _btnDeps.Enabled = _btnImport.Enabled = _btnPlay.Enabled = _btnPlaySolo.Enabled = false;
                _btnClone.Enabled = true;
                _btnUpdate.Enabled = false;
                ApplyBanner(root);
                return;
            }

            string version = UpdateCheck.LocalVersion(root);
            _version.Text = "Ascend Reborn v" + (version.Length > 0 ? version : "?") + "  -  " + root;
            _btnClone.Enabled = false;
            _btnUpdate.Enabled = true;
            _btnDeps.Enabled = _btnImport.Enabled = _btnPlay.Enabled = _btnPlaySolo.Enabled = true;

            bool imported = Setup.HasImport(root);
            _btnImport.Text = imported ? "Re-import Tribes: Ascend assets" : "Import Tribes: Ascend assets";
            _btnPlay.Enabled = imported;
            _btnPlaySolo.Enabled = imported;
            // The play buttons stay off until the Tribes: Ascend asset import has produced
            // maps-original (the game files are not in the repo, so a fresh clone has none).
            // Say so: a greyed button with no explanation reads as a broken install.
            if (!imported && !_importHintShown)
            {
                _importHintShown = true;
                Log("Start game is disabled until the assets are imported: press \"Import Tribes: Ascend assets\" (you need Tribes: Ascend installed, then pick its folder when asked).");
            }
            ApplyBanner(root);
        }

        /// <summary>
        /// The exe carries its icon (build.ps1 passes /win32icon), so the window and the
        /// taskbar button show it. ExtractAssociatedIcon fails on odd builds - never fatal.
        /// </summary>
        private void ApplyIcon()
        {
            try
            {
                string exe = System.Windows.Forms.Application.ExecutablePath;
                if (string.IsNullOrEmpty(exe) || !File.Exists(exe)) return;
                Icon = Icon.ExtractAssociatedIcon(exe);
            }
            catch { }
        }

        /// <summary>
        /// The whole Quick Start in one click: toolchain (Node + Git, installed when
        /// missing), clone, npm install, then the Tribes: Ascend asset import.
        /// </summary>
        private void InstallEverything()
        {
            Step("Install", delegate(Action<string> log)
            {
                // 1. Toolchain. Anything missing is installed; a fresh install is not on
                //    this process's PATH, so we refresh PATH from the registry for the
                //    rest of the run instead of asking the player to restart.
                Log("checking the toolchain...");
                bool node = Setup.NodeInstalled(log);
                bool git = Setup.GitInstalled(log);
                if (!node) { Log("Node.js missing - installing it."); Setup.InstallNode(log); }
                if (!git) { Log("Git missing - installing it."); Setup.InstallGit(log); }
                Setup.PathExtra = Runner.RefreshPath();
                node = Setup.NodeInstalled(log);
                git = Setup.GitInstalled(log);
                if (!node || !git)
                {
                    Log("Node.js / Git still not visible to this launcher.");
                    Log("Finish those installs, then start the launcher again and press Install.");
                    return;
                }

                // 2. The game itself.
                string root = DetectRepo();
                if (root.Length == 0)
                {
                    string parent = TargetParent();
                    Log("downloading Ascend Reborn into " + parent);
                    if (!Setup.Clone(parent, log))
                    {
                        Log("clone failed - check the log above, then press Install again.");
                        return;
                    }
                    AppInfo.TargetFolder = parent;
                    AppInfo.Save();
                    root = DetectRepo();
                    if (root.Length == 0)
                    {
                        Log("clone reported success but no .git folder was found in " + parent);
                        return;
                    }
                }
                _repoRoot = root;
                BeginInvoke(new Action(delegate { RefreshRepoState(); }));
                Log("game folder: " + root);

                // 3. Workspace dependencies.
                if (!Setup.NpmInstall(root, log))
                {
                    Log("npm install failed - press Install again once the error above is fixed.");
                    return;
                }

                // 4. The player's own Tribes: Ascend data.
                string ta = Setup.FindTaInstall();
                if (ta.Length > 0) Log("found Tribes: Ascend data at " + ta);
                if (!Setup.ImportAssets(root, ta, log))
                {
                    Log("asset import failed - point the importer at your TribesGame\\CookedPC folder.");
                    return;
                }

                Log("everything is installed. Press \"Start game (server)\" to play.");
            });
        }

        private void ApplyBanner(string root)
        {
            try
            {
                Bitmap next = Theme.Banner(root, 908, 96);
                if (_banner.Image != null) _banner.Image.Dispose();
                _banner.Image = next;
            }
            catch { }
        }

        // --- Actions --------------------------------------------------------

        private void Play(bool withServers)
        {
            string root = DetectRepo();
            if (root.Length == 0)
            {
                Log("No Ascend Reborn folder found - use \"Download the game\" first.");
                return;
            }
            _repoRoot = root;
            if (withServers)
            {
                Log("starting the client build and a server host in a console window...");
                Setup.LaunchWithServers(root);
            }
            else
            {
                Log("starting the client in a console window...");
                Setup.LaunchClientOnly(root);
            }
            Log("the browser opens at " + AppInfo.GameUrl + " when the build is ready.");
            Log("leave that console open while you play; use \"Close servers\" to shut it down.");
            System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
            timer.Interval = 12000;
            timer.Tick += delegate(object s, EventArgs e)
            {
                timer.Stop();
                Setup.OpenGame();
            };
            timer.Start();
        }

        private void BeginCheck()
        {
            StepAdvisory("Checking for updates", delegate(Action<string> log)
            {
                _update = UpdateCheck.Run(string.IsNullOrEmpty(_repoRoot) ? AppInfo.ExeDirectory : _repoRoot, log);
                BeginInvoke(new Action(delegate
                {
                    // Advisory line only: nothing here disables a button.
                    _status.Text = _update.Message;
                    _status.ForeColor = _update.UpToDate ? Theme.Ok : Theme.Warn;
                }));
            });
        }

        private void CheckForUpdates()
        {
            BeginCheck();
        }

        private void SelfUpdate()
        {
            if (_update == null || !_update.Checked)
            {
                Log("checking GitHub first...");
                BeginCheck();
                return;
            }
            // No "already current" short-circuit here. The only version the launcher can
            // honestly compare against is the release asset itself, and GitHub always hands
            // back the newest one - so offering the download is always safe, and a clone
            // whose package.json lags the release tag (which is normal) never blocks it.
            if (_update.LauncherAssetUrl.Length == 0)
            {
                Log("the latest release has no launcher asset - downloading from the release page.");
                Setup.OpenUrl(_update.ReleaseUrl);
                return;
            }
            Step("Launcher update", delegate(Action<string> log)
            {
                if (Setup.UpdateLauncher(_update.LauncherAssetUrl, log))
                {
                    BeginInvoke(new Action(delegate
                    {
                        Process.Start(Path.Combine(AppInfo.ExeDirectory, "APPLY-UPDATE.cmd"));
                        Close();
                    }));
                }
            });
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            AppInfo.Save();
            base.OnFormClosed(e);
        }
    }
}

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Windows.Forms;

namespace AscendReborn.Launcher
{
    /// <summary>
    /// Tribes: Ascend palette (dark teal-black, aqua accent). The banner uses the game's
    /// own splash art when the player has imported it, and a drawn fallback otherwise -
    /// the launcher never ships with Hi-Rez art baked in.
    /// </summary>
    public static class Theme
    {
        public static readonly Color Bg = Color.FromArgb(10, 22, 26);
        public static readonly Color PanelBg = Color.FromArgb(16, 36, 41);
        public static readonly Color PanelDark = Color.FromArgb(12, 27, 31);
        public static readonly Color Accent = Color.FromArgb(95, 224, 180);
        public static readonly Color AccentDim = Color.FromArgb(46, 110, 96);
        public static readonly Color Text = Color.FromArgb(214, 232, 228);
        public static readonly Color TextDim = Color.FromArgb(130, 152, 148);
        public static readonly Color LogBg = Color.FromArgb(7, 15, 18);
        public static readonly Color Ok = Color.FromArgb(110, 226, 170);
        public static readonly Color Warn = Color.FromArgb(232, 190, 90);
        public static readonly Color Bad = Color.FromArgb(232, 108, 92);

        public static readonly Font Ui = new Font("Segoe UI", 9.5f);
        public static readonly Font UiSmall = new Font("Segoe UI", 8.5f);
        public static readonly Font UiTitle = new Font("Segoe UI", 15f, FontStyle.Bold);
        public static readonly Font UiSection = new Font("Segoe UI", 10.5f, FontStyle.Bold);
        public static readonly Font Mono = new Font("Consolas", 8.5f);

        /// <summary>Draws a rounded panel with a hairline accent edge.</summary>
        public static void DrawPanel(Graphics g, Rectangle r, int radius)
        {
            using (GraphicsPath path = RoundRect(r, radius))
            {
                using (SolidBrush b = new SolidBrush(PanelBg)) g.FillPath(b, path);
                using (Pen p = new Pen(AccentDim, 1f)) g.DrawPath(p, path);
            }
        }

        public static GraphicsPath RoundRect(Rectangle r, int radius)
        {
            GraphicsPath path = new GraphicsPath();
            int d = radius * 2;
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        /// <summary>
        /// Banner art: the imported splash when present, otherwise a drawn gradient with
        /// the ring mark. Returns the bitmap to blit; caller disposes.
        /// </summary>
        public static Bitmap Banner(string repoRoot, int width, int height)
        {
            Bitmap source = TryLoadSplash(repoRoot);
            Bitmap target = new Bitmap(width, height);
            using (Graphics g = Graphics.FromImage(target))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;

                using (LinearGradientBrush bg = new LinearGradientBrush(
                    new Rectangle(0, 0, width, height),
                    Color.FromArgb(18, 52, 56), Color.FromArgb(5, 12, 14), 90f))
                {
                    g.FillRectangle(bg, 0, 0, width, height);
                }

                if (source != null)
                {
                    // Preserve aspect, fit inside the band.
                    float scale = Math.Min((float)width / source.Width, (float)height / source.Height);
                    int w = (int)(source.Width * scale);
                    int h = (int)(source.Height * scale);
                    g.DrawImage(source, (width - w) / 2, (height - h) / 2, w, h);
                    source.Dispose();
                }
                else
                {
                    using (Pen p = new Pen(Color.FromArgb(120, 95, 224, 180), 3f))
                        g.DrawEllipse(p, 8, 8, height - 16, height - 16);
                    using (Font f = new Font("Segoe UI", height * 0.34f, FontStyle.Bold))
                    using (SolidBrush b = new SolidBrush(Color.White))
                        g.DrawString("AR", f, b, 16, height * 0.12f);
                    using (Font f = new Font("Segoe UI", 11f, FontStyle.Bold))
                    using (SolidBrush b = new SolidBrush(Accent))
                        g.DrawString("ASCEND REBORN", f, b, height + 14, height * 0.30f);
                    using (Font f = new Font("Segoe UI", 8f))
                    using (SolidBrush b = new SolidBrush(TextDim))
                        g.DrawString("browser revival of Tribes: Ascend", f, b, height + 16, height * 0.56f);
                }
            }
            return target;
        }

        private static Bitmap TryLoadSplash(string repoRoot)
        {
            if (string.IsNullOrEmpty(repoRoot)) return null;
            string[] tries = new string[]
            {
                Path.Combine(repoRoot, "maps-original", "ui", "splash.png"),
                Path.Combine(repoRoot, "maps-original", "ui", "tribeshud_tr_mainmenu_i7.png"),
                Path.Combine(repoRoot, "maps-original", "ui", "tribesmenu_loadingscene_loadingscene_id.png"),
            };
            foreach (string path in tries)
            {
                if (!File.Exists(path)) continue;
                try
                {
                    // Load into a private copy so the file stays free for the game importer.
                    using (Bitmap raw = new Bitmap(path)) return new Bitmap(raw);
                }
                catch { }
            }
            return null;
        }

        public static Button MakeButton(string text)
        {
            Button b = new Button();
            b.Text = text;
            b.Font = Ui;
            b.ForeColor = Color.FromArgb(8, 20, 22);
            b.BackColor = Accent;
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderColor = AccentDim;
            b.FlatAppearance.BorderSize = 1;
            b.FlatAppearance.MouseOverBackColor = Color.FromArgb(126, 240, 200);
            b.FlatAppearance.MouseDownBackColor = Color.FromArgb(60, 160, 128);
            b.Height = 30;
            return b;
        }

        public static Label MakeLabel(string text, bool dim)
        {
            Label l = new Label();
            l.Text = text;
            l.AutoSize = false;
            l.Font = dim ? UiSmall : Ui;
            l.ForeColor = dim ? TextDim : Text;
            l.BackColor = Color.Transparent;
            return l;
        }
    }
}

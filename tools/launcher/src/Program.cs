using System;
using System.Windows.Forms;

namespace AscendReborn.Launcher
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            // GitHub's API requires TLS 1.2; .NET Framework 4.x defaults to lower.
            System.Net.ServicePointManager.SecurityProtocol =
                System.Net.SecurityProtocolType.Tls |
                (System.Net.SecurityProtocolType)0x00000C00 |   // Tls11
                (System.Net.SecurityProtocolType)0x00003000;    // Tls12

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }
}

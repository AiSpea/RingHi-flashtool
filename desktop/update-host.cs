using System;
using System.Diagnostics;
using System.IO;
using System.Text;

// GUI subsystem: unlike a detached PowerShell console process, this host can
// survive the Electron parent and supply a valid hidden console to PowerShell.
internal static class UpdateHost {
    [STAThread]
    private static int Main(string[] args) {
        if (args.Length != 1 || !Path.IsPathRooted(args[0])) return 2;
        string config = Path.GetFullPath(args[0]);
        string directory = Path.GetDirectoryName(config);
        string log = Path.Combine(directory, "install-portable.log");
        object gate = new object();
        Action<string> write = text => { lock (gate) File.AppendAllText(log, DateTime.UtcNow.ToString("o") + " " + text + Environment.NewLine); };
        try {
            string script = Path.Combine(directory, "install-portable.ps1");
            string command = "& ([ScriptBlock]::Create([IO.File]::ReadAllText('" + script.Replace("'", "''") + "'))) -ConfigPath '" + config.Replace("'", "''") + "'";
            var start = new ProcessStartInfo {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe"),
                Arguments = "-NoProfile -NonInteractive -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(command)),
                WorkingDirectory = directory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using (var process = new Process { StartInfo = start }) {
                process.OutputDataReceived += (sender, e) => { if (e.Data != null) write(e.Data); };
                process.ErrorDataReceived += (sender, e) => { if (e.Data != null) write(e.Data); };
                process.Start();
                write("PowerShell started: " + process.Id);
                process.StandardInput.Close();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                process.WaitForExit();
                write("PowerShell exited: " + process.ExitCode);
                return process.ExitCode;
            }
        } catch (Exception error) {
            write(error.ToString());
            return 1;
        }
    }
}

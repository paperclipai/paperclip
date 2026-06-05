using System;
using System.Diagnostics;
using System.IO;
using System.Text;

public static class HermesWslBridge
{
    private const string DefaultDistro = "Ubuntu";
    private const string DefaultHermesPath = "hermes";

    public static int Main(string[] args)
    {
        string queryTempFile = null;
        try
        {
            args = MoveChatQueryToTempFile(args, out queryTempFile);
            var exitCode = RunWsl(args);
            return exitCode;
        }
        finally
        {
            if (!string.IsNullOrEmpty(queryTempFile))
            {
                try
                {
                    File.Delete(queryTempFile);
                }
                catch
                {
                    // Best-effort cleanup only.
                }
            }
        }
    }

    private static int RunWsl(string[] args)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "wsl.exe",
            Arguments = BuildArguments(args),
            UseShellExecute = false,
        };

        using (var process = Process.Start(psi))
        {
            process.WaitForExit();
            return process.ExitCode;
        }
    }

    private static string[] MoveChatQueryToTempFile(string[] args, out string queryTempFile)
    {
        queryTempFile = null;
        if (args.Length < 3 || args[0] != "chat")
        {
            return args;
        }

        var queryIndex = -1;
        for (var i = 1; i < args.Length; i++)
        {
            if (args[i] == "-q" || args[i] == "--query")
            {
                queryIndex = i;
                break;
            }
        }

        if (queryIndex < 0 || queryIndex + 1 >= args.Length)
        {
            return args;
        }

        queryTempFile = Path.Combine(Path.GetTempPath(), "paperclip-hermes-query-" + Guid.NewGuid().ToString("N") + ".txt");
        File.WriteAllText(queryTempFile, args[queryIndex + 1], new UTF8Encoding(false));

        var rewritten = new string[args.Length - 1];
        rewritten[0] = "__paperclip_chat_query_file__";
        rewritten[1] = ToWslPath(queryTempFile);
        var targetIndex = 2;
        for (var i = 1; i < args.Length; i++)
        {
            if (i == queryIndex || i == queryIndex + 1)
            {
                continue;
            }
            rewritten[targetIndex] = args[i];
            targetIndex++;
        }
        return rewritten;
    }

    private static string BuildArguments(string[] args)
    {
        var builder = new StringBuilder();
        builder.Append("-d ");
        builder.Append(GetEnv("HERMES_WSL_DISTRO", DefaultDistro));
        builder.Append(" -- ");

        if (args.Length > 0 && args[0] == "__paperclip_chat_query_file__")
        {
            builder.Append("/usr/bin/python3");
            AppendArg(builder, ToWslPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "hermes-wsl-query-helper.py")));
            for (var i = 1; i < args.Length; i++)
            {
                AppendArg(builder, args[i] ?? string.Empty);
            }
            return builder.ToString();
        }

        builder.Append(GetEnv("HERMES_WSL_PATH", DefaultHermesPath));

        foreach (var arg in args)
        {
            AppendArg(builder, arg ?? string.Empty);
        }

        return builder.ToString();
    }

    private static void AppendArg(StringBuilder builder, string arg)
    {
        if (builder.Length > 0)
        {
            builder.Append(' ');
        }

        builder.Append('"');
        var backslashes = 0;
        foreach (var ch in arg)
        {
            if (ch == '\\')
            {
                backslashes++;
                continue;
            }

            if (ch == '"')
            {
                builder.Append('\\', backslashes * 2 + 1);
                builder.Append('"');
                backslashes = 0;
                continue;
            }

            if (backslashes > 0)
            {
                builder.Append('\\', backslashes);
                backslashes = 0;
            }
            builder.Append(ch);
        }

        if (backslashes > 0)
        {
            builder.Append('\\', backslashes * 2);
        }
        builder.Append('"');
    }

    private static string ToWslPath(string windowsPath)
    {
        var fullPath = Path.GetFullPath(windowsPath);
        if (fullPath.Length >= 3 && fullPath[1] == ':' && (fullPath[2] == '\\' || fullPath[2] == '/'))
        {
            var drive = char.ToLowerInvariant(fullPath[0]);
            var rest = fullPath.Substring(3).Replace('\\', '/');
            return "/mnt/" + drive + "/" + rest;
        }
        return fullPath.Replace('\\', '/');
    }

    private static string GetEnv(string name, string fallback)
    {
        var value = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrWhiteSpace(value) ? fallback : value;
    }
}

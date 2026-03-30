import paramiko
import sys
import os

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# Read from .env
ip = "46.224.172.180"
user = "root"
password = "=!Paperclip01"

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(ip, username=user, password=password, timeout=10)

cmd = sys.argv[1] if len(sys.argv) > 1 else "echo 'No command provided'"

stdin, stdout, stderr = ssh.exec_command(cmd, timeout=600)
for line in iter(stdout.readline, ""):
    print(line, end="")
err = stderr.read().decode()
if err:
    print("STDERR:", err, file=sys.stderr)

exit_code = stdout.channel.recv_exit_status()
ssh.close()
sys.exit(exit_code)

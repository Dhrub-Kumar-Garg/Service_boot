# Press a real Ctrl+C: write byte 0x03 to a pseudo-terminal. The terminal
# driver turns it into SIGINT for the foreground process group, exactly like a
# keyboard. presses = 1 (graceful) or 2 (forced).
import os, pty, sys, time, select, subprocess

presses = int(sys.argv[1])
cwd = sys.argv[2]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvp("node", ["node", "bin/serviceboot.js", "up", "--config", "samples/wide.yml", "--quiet", "--no-color"])
buf = b""
def pump(t):
    global buf
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            buf += data
    return True
deadline = time.time() + 20
while b"All 10 services ready" not in buf and time.time() < deadline:
    pump(0.1)
time.sleep(0.3)
t0 = time.time()
for i in range(presses):
    os.write(fd, b"\x03")
    time.sleep(0.02)
while pump(0.2):
    pass
_, status = os.waitpid(pid, 0)
elapsed = (time.time() - t0) * 1000
print(buf.decode("utf-8", "replace").replace("\r", ""))
print(f"presses={presses} exit_code={os.waitstatus_to_exitcode(status)} ms_from_first_ctrl_c={elapsed:.0f}")
time.sleep(0.5)
left = subprocess.run(["bash", "-c", "ps -A -o pid=,stat=,args= | grep -E '[m]ock-service.js --port 41'"], capture_output=True, text=True).stdout
print("remaining mock processes:", left.strip() or "none")
print("pid file:", "present" if os.path.exists(os.path.join(cwd, ".serviceboot/pids.json")) else "absent")

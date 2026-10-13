# Sandbox-only helper: this container's PID 1 never reaps orphaned zombies,
# which a normal Linux init (systemd/tini) does. Become a child subreaper,
# run the command, and reap every orphan so the environment matches a real host.
import ctypes, os, sys, signal
libc = ctypes.CDLL(None, use_errno=True)
libc.prctl(36, 1, 0, 0, 0)  # PR_SET_CHILD_SUBREAPER
pid = os.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
signal.signal(signal.SIGINT, lambda *a: os.kill(pid, signal.SIGINT))
status = 0
while True:
    try:
        p, st = os.waitpid(-1, 0)
    except ChildProcessError:
        break
    except InterruptedError:
        continue
    if p == pid:
        status = os.waitstatus_to_exitcode(st)
sys.exit(status if status >= 0 else 128 - status)

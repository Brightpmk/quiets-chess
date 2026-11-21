#!/usr/bin/env python3
"""Cross-platform installer, launcher and test runner. Python 3.11+ required."""
import argparse
from contextlib import suppress
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
FRONTEND = ROOT / 'frontend'
VENV = ROOT / '.venv'
PYTHON = VENV / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')


def npm():
    executable = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
    if not executable: raise SystemExit('Install Node.js 22.13+ (recommended: Node 24 LTS), including npm.')
    return executable


def run(args, cwd=ROOT, env=None):
    print('+', ' '.join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=cwd, env=env, check=True)


def backend_command():
    if not PYTHON.exists(): raise SystemExit('Run python manage.py setup first.')
    return [str(PYTHON), '-m', 'uvicorn', 'backend.app:app', '--host', '127.0.0.1', '--port', '8000', '--ws-max-size', '65536']


def terminate(process):
    if process.poll() is not None: return
    if os.name == 'nt':
        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        with suppress(ProcessLookupError): os.killpg(process.pid, signal.SIGTERM)
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            with suppress(ProcessLookupError): os.killpg(process.pid, signal.SIGKILL)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['setup', 'start', 'dev', 'test', 'check'])
    parser.add_argument('--engine', action='store_true', help='Include real Stockfish tests (test command)')
    args = parser.parse_args()
    if sys.version_info < (3, 11): raise SystemExit('Python 3.11 or newer is required.')
    os.chdir(ROOT)
    if args.command == 'setup':
        node = shutil.which('node')
        if not node: npm()
        version = subprocess.check_output([node, '-p', 'process.versions.node'], text=True).strip()
        parts = tuple(map(int, version.split('.')))
        if parts < (22, 13, 0): raise SystemExit('Node.js 22.13+ is required; use Node 24 LTS.')
        if not VENV.exists(): run([sys.executable, '-m', 'venv', VENV])
        run([PYTHON, '-m', 'pip', 'install', '-r', 'backend/requirements-dev.txt'])
        run([npm(), 'ci' if (FRONTEND / 'package-lock.json').exists() else 'install', '--include=dev'], cwd=FRONTEND)
        run([npm(), 'run', 'build'], cwd=FRONTEND)
        if not (ROOT / '.env').exists(): shutil.copyfile(ROOT / '.env.example', ROOT / '.env')
        print('Setup finished. Set STOCKFISH_PATH in .env, then run: python manage.py start')
    elif args.command == 'start':
        if not (FRONTEND / 'dist/index.html').exists(): raise SystemExit('Frontend build missing. Run python manage.py setup.')
        print('Open http://127.0.0.1:8000 — Ctrl+C stops the application.', flush=True)
        run(backend_command())
    elif args.command == 'dev':
        commands = [(backend_command(), ROOT), ([npm(), 'run', 'dev'], FRONTEND)]
        processes = []
        try:
            for command, cwd in commands:
                processes.append(subprocess.Popen(command, cwd=cwd, start_new_session=os.name != 'nt'))
            print('Open http://127.0.0.1:5173 — frontend hot reload; restart for backend changes.', flush=True)
            while all(p.poll() is None for p in processes): time.sleep(.25)
            for process in processes:
                if process.poll() not in (None, 0): raise SystemExit(process.returncode)
        finally:
            for process in reversed(processes): terminate(process)
    elif args.command == 'test':
        if not PYTHON.exists(): raise SystemExit('Run python manage.py setup first.')
        env = dict(os.environ)
        if args.engine: env['RUN_STOCKFISH_TESTS'] = '1'
        run([PYTHON, '-m', 'pytest', '-v'], env=env)
        run([npm(), 'test'], cwd=FRONTEND, env=env)
        run([npm(), 'run', 'build'], cwd=FRONTEND, env=env)
    else:
        if not PYTHON.exists(): raise SystemExit('Run python manage.py setup first.')
        run([PYTHON, 'scripts/check_engine.py'])


if __name__ == '__main__':
    try: main()
    except KeyboardInterrupt: pass
    except subprocess.CalledProcessError as exc: raise SystemExit(exc.returncode)

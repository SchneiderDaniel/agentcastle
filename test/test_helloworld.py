import subprocess
import os


def test_helloworld_stdout():
    """TC1 – stdout output: should print 'hello world' followed by newline."""
    script_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    result = subprocess.run(
        ["python3", "helloworld.py"],
        capture_output=True,
        cwd=script_dir,
    )
    assert result.stdout == b"hello world\n"


def test_helloworld_exit_code():
    """TC2 – exit code: should be 0."""
    script_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    result = subprocess.run(
        ["python3", "helloworld.py"],
        capture_output=True,
        cwd=script_dir,
    )
    assert result.returncode == 0

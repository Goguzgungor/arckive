import stat
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "arc-gate-env.sh"


def run(target, source):
    return subprocess.run(["bash", str(SCRIPT), str(target), str(source)], capture_output=True, text=True)


def test_writes_the_token_and_arcs_own_ports(tmp_path):
    source = tmp_path / "stellar.env"
    source.write_text("RADAR_TOKEN=s3cret\n")
    target = tmp_path / "arc" / "env"
    done = run(target, source)
    assert done.returncode == 0 and "s3cret" not in done.stdout + done.stderr
    assert target.read_text().splitlines() == [
        "RADAR_TOKEN=s3cret", "RADAR_GATE_PORT=8921", "LAYAD_ENDPOINT=http://127.0.0.1:8920"]
    assert stat.S_IMODE(target.stat().st_mode) == 0o600


def test_a_stale_file_is_corrected_and_keeps_its_token(tmp_path):
    source = tmp_path / "stellar.env"
    source.write_text("RADAR_TOKEN=other\n")
    target = tmp_path / "env"
    # A leftover that would put Arc's gate on the shared pair's ports.
    target.write_text("RADAR_TOKEN=mine\nRADAR_GATE_PORT=8919\nLAYAD_ENDPOINT=http://127.0.0.1:8918\n")
    assert run(target, source).returncode == 0
    assert target.read_text().splitlines() == [
        "RADAR_TOKEN=mine", "RADAR_GATE_PORT=8921", "LAYAD_ENDPOINT=http://127.0.0.1:8920"]


def test_no_token_anywhere_is_refused(tmp_path):
    source = tmp_path / "stellar.env"
    source.write_text("SOMETHING=else\n")
    done = run(tmp_path / "env", source)
    assert done.returncode != 0 and not (tmp_path / "env").exists()

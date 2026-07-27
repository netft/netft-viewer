#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${NETFT_SENSOR_HOST:-}" ]]; then
  echo "NETFT_SENSOR_HOST is required" >&2
  exit 64
fi
if ! command -v timeout >/dev/null 2>&1; then
  echo "timeout is required" >&2
  exit 69
fi

if [[ "${NETFT_ALLOW_BIAS:-0}" == "1" ]]; then
  echo "WARNING: Bias changes the sensor zero. Unload the sensor before continuing." >&2
  if [[ "${NETFT_CONFIRM_BIAS:-}" != "YES" ]]; then
    echo "Set NETFT_CONFIRM_BIAS=YES only after confirming the sensor is unloaded." >&2
    exit 64
  fi
fi

hardware_build="build/hardware"
temporary_directory="$(mktemp -d)"
cleanup() {
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT

export NETFT_HARDWARE_OUTPUT="$temporary_directory/hardware.csv"
cmake \
  -S . \
  -B "$hardware_build" \
  -G Ninja \
  -DBUILD_TESTING=OFF \
  -DNETFT_VIEWER_BUILD_HARDWARE_TEST=ON \
  -DCMAKE_BUILD_TYPE=Release
cmake --build "$hardware_build" --target netft-viewer-hardware-test
timeout --signal=TERM --kill-after=5s 35s \
  "$hardware_build/test/hardware/netft-viewer-hardware-test"

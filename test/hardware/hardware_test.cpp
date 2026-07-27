#include "bias_authorization.hpp"

#include "netft/discovery.hpp"
#include "netft/types.hpp"
#include "netft_viewer/session.hpp"

#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>

namespace {

using namespace std::chrono_literals;

struct Summary {
  bool bias_requested{};
  bool configuration_authoritative{};
  bool csv_complete{};
  bool health_live_while_paused{};
  bool pause_verified{};
  bool resume_verified{};
  bool streaming_verified{};
  std::uint64_t accepted_samples{};
  std::uint64_t written_samples{};
};

void print_summary(const Summary &summary, bool passed) {
  const nlohmann::json result{
      {"accepted_samples", summary.accepted_samples},
      {"bias_requested", summary.bias_requested},
      {"configuration_authoritative", summary.configuration_authoritative},
      {"csv_complete", summary.csv_complete},
      {"health_live_while_paused", summary.health_live_while_paused},
      {"passed", passed},
      {"pause_verified", summary.pause_verified},
      {"resume_verified", summary.resume_verified},
      {"streaming_verified", summary.streaming_verified},
      {"written_samples", summary.written_samples},
  };
  std::cout << result.dump() << '\n';
}

bool wait_until(std::chrono::milliseconds timeout,
                const std::function<bool()> &predicate) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (std::chrono::steady_clock::now() < deadline) {
    if (predicate()) {
      return true;
    }
    std::this_thread::sleep_for(20ms);
  }
  return predicate();
}

std::optional<std::string> environment(const char *name) {
  const auto *value = std::getenv(name);
  if (value == nullptr || *value == '\0') {
    return std::nullopt;
  }
  return std::string{value};
}

bool same_calibration(const netft::SensorConfiguration &left,
                      const netft::SensorConfiguration &right) {
  return left.source == netft::CalibrationSource::Sensor &&
         right.source == netft::CalibrationSource::Sensor &&
         left.calibration.counts_per_force_unit > 0.0 &&
         left.calibration.counts_per_torque_unit > 0.0 &&
         left.calibration.counts_per_force_unit ==
             right.calibration.counts_per_force_unit &&
         left.calibration.counts_per_torque_unit ==
             right.calibration.counts_per_torque_unit &&
         left.calibration.force_unit == right.calibration.force_unit &&
         left.calibration.torque_unit == right.calibration.torque_unit &&
         left.calibration.force_unit != netft::ForceUnit::Unknown &&
         left.calibration.torque_unit != netft::TorqueUnit::Unknown;
}

std::uint64_t csv_data_rows(const std::filesystem::path &path) {
  std::ifstream input(path);
  if (!input) {
    return 0U;
  }
  std::uint64_t lines{};
  std::string line;
  while (std::getline(input, line)) {
    ++lines;
  }
  return lines == 0U ? 0U : lines - 1U;
}

} // namespace

int main() {
  Summary summary;
  netft_viewer::SessionEventSink sink;
  netft_viewer::ViewerSession session(sink);
  bool connected = false;
  bool recording = false;

  const auto host = environment("NETFT_SENSOR_HOST");
  const auto output = environment("NETFT_HARDWARE_OUTPUT");
  const auto allow_bias = netft_viewer::hardware::bias_authorized(
      std::getenv("NETFT_ALLOW_BIAS"), std::getenv("NETFT_CONFIRM_BIAS"));
  if (!host || !output) {
    print_summary(summary, false);
    return 64;
  }

  try {
    netft::DiscoveryOptions discovery_options;
    discovery_options.sensor_host = *host;
    discovery_options.connect_timeout = 1s;
    discovery_options.total_timeout = 3s;
    const auto discovered = netft::discover_sensor(discovery_options);

    netft::Config config;
    config.sensor_host = *host;
    config.receive_timeout = 250ms;
    config.configuration_connect_timeout = 1s;
    config.configuration_timeout = 3s;
    config.reconnect_initial_delay = 100ms;
    config.reconnect_max_delay = 500ms;

    if (session.connect(config) != netft_viewer::SessionResult::Ok) {
      throw std::runtime_error("connect");
    }
    connected = true;
    if (!wait_until(6s, [&] {
          const auto snapshot = session.snapshot();
          return snapshot.connection.state ==
                     netft_viewer::ConnectionState::Streaming &&
                 snapshot.latest_sample.has_value() &&
                 snapshot.configuration.has_value() &&
                 snapshot.health.delivered_count > 0U;
        })) {
      throw std::runtime_error("stream");
    }

    auto snapshot = session.snapshot();
    summary.streaming_verified = true;
    summary.configuration_authoritative =
        snapshot.configuration &&
        same_calibration(discovered, *snapshot.configuration);
    if (!summary.configuration_authoritative) {
      throw std::runtime_error("configuration");
    }

    const std::filesystem::path output_path{*output};
    if (session.start_recording(output_path, false) !=
        netft_viewer::SessionResult::Ok) {
      throw std::runtime_error("record");
    }
    recording = true;
    if (!wait_until(4s, [&] {
          return session.snapshot().recording.accepted_samples >= 8U;
        })) {
      throw std::runtime_error("recording samples");
    }

    if (session.set_paused(true) != netft_viewer::SessionResult::Ok) {
      throw std::runtime_error("pause");
    }
    const auto paused = session.snapshot();
    const auto paused_sequence = paused.latest_sample->sample.rdt_sequence;
    const auto paused_delivery_count = paused.health.delivered_count;
    const auto paused_accepted = paused.recording.accepted_samples;
    summary.pause_verified =
        paused.connection.paused &&
        paused.recording.state == netft_viewer::RecordingState::Paused &&
        paused.recording.accepted_samples == paused.recording.written_samples;
    if (!summary.pause_verified) {
      throw std::runtime_error("pause drain");
    }

    summary.health_live_while_paused = wait_until(2s, [&] {
      const auto current = session.snapshot();
      return current.health.delivered_count > paused_delivery_count &&
             current.latest_sample &&
             current.latest_sample->sample.rdt_sequence == paused_sequence &&
             current.recording.accepted_samples == paused_accepted;
    });
    if (!summary.health_live_while_paused) {
      throw std::runtime_error("paused health");
    }

    if (session.set_paused(false) != netft_viewer::SessionResult::Ok) {
      throw std::runtime_error("resume");
    }
    summary.resume_verified = wait_until(3s, [&] {
      const auto current = session.snapshot();
      return !current.connection.paused && current.latest_sample &&
             current.latest_sample->sample.rdt_sequence != paused_sequence &&
             current.recording.accepted_samples > paused_accepted;
    });
    if (!summary.resume_verified) {
      throw std::runtime_error("resumed stream");
    }

    if (allow_bias) {
      if (session.bias() != netft_viewer::SessionResult::Ok) {
        throw std::runtime_error("bias");
      }
      summary.bias_requested = true;
    }

    if (session.stop_recording() != netft_viewer::SessionResult::Ok) {
      throw std::runtime_error("stop recording");
    }
    recording = false;
    snapshot = session.snapshot();
    summary.accepted_samples = snapshot.recording.accepted_samples;
    summary.written_samples = snapshot.recording.written_samples;
    auto partial_path = output_path;
    partial_path += ".partial";
    summary.csv_complete =
        summary.accepted_samples > 0U &&
        summary.accepted_samples == summary.written_samples &&
        csv_data_rows(output_path) == summary.written_samples &&
        std::filesystem::is_regular_file(output_path) &&
        !std::filesystem::exists(partial_path);
    if (!summary.csv_complete) {
      throw std::runtime_error("csv");
    }

    if (session.disconnect() != netft_viewer::SessionResult::Ok) {
      throw std::runtime_error("disconnect");
    }
    connected = false;
    print_summary(summary, true);
    return 0;
  } catch (...) {
    if (recording) {
      static_cast<void>(session.stop_recording());
    }
    if (connected) {
      static_cast<void>(session.disconnect());
    }
    print_summary(summary, false);
    return 1;
  }
}

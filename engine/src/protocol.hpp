// Framed request/response protocol over a byte stream (stdin/stdout).
//
// Frame layout (little-endian):
//   "FFE1" | u32 header_len | header (UTF-8 JSON object) | u32 payload_len | payload
#pragma once
#include <cstdint>
#include <cstdio>
#include <optional>
#include <stdexcept>
#include <vector>

#include "json.hpp"

namespace ffe {

inline constexpr int kProtocolVersion = 1;
inline constexpr std::uint32_t kMaxHeaderBytes = 1u << 20;
inline constexpr std::uint32_t kMaxPayloadBytes = 1u << 30;

struct Frame {
  Json header;
  std::vector<std::uint8_t> payload;
};

class ProtocolError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

// Returns nullopt on clean EOF before a frame starts; throws on malformed or truncated frames.
std::optional<Frame> read_frame(std::FILE* in);
void write_frame(std::FILE* out, const Frame& frame);

// Encode/decode a frame to/from memory (used by tests and by write_frame).
std::vector<std::uint8_t> encode_frame(const Frame& frame);

}  // namespace ffe

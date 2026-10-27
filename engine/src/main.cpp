// frameflow-film: out-of-process film simulation engine.
// Reads framed requests on stdin, writes framed responses on stdout; logs go to stderr.
#include <bit>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>

#include "engine.hpp"

static_assert(std::endian::native == std::endian::little, "engine payloads assume a little-endian host");

namespace {

void usage() {
  std::fprintf(stderr, "usage: frameflow-film --data <stocks-dir> [--threads N]\n");
}

}  // namespace

int main(int argc, char** argv) {
  std::string data;
  unsigned threads = 0;
  for (int i = 1; i < argc; ++i) {
    if (!std::strcmp(argv[i], "--data") && i + 1 < argc) data = argv[++i];
    else if (!std::strcmp(argv[i], "--threads") && i + 1 < argc) threads = static_cast<unsigned>(std::stoul(argv[++i]));
    else if (!std::strcmp(argv[i], "--version")) { std::printf("%s\n", ffe::kEngineVersion); return 0; }
    else { usage(); return 2; }
  }
  if (data.empty()) { usage(); return 2; }

  std::shared_ptr<const ffe::StockLibrary> stocks;
  try {
    stocks = std::make_shared<const ffe::StockLibrary>(data);
  } catch (const std::exception& e) {
    std::fprintf(stderr, "frameflow-film: cannot load stocks: %s\n", e.what());
    return 3;
  }
  ffe::Engine engine(stocks, threads);
  std::setvbuf(stdout, nullptr, _IOFBF, 1 << 20);
  try {
    while (auto frame = ffe::read_frame(stdin)) {
      ffe::write_frame(stdout, engine.handle(*frame));
      if (engine.shutdown_requested()) break;
    }
  } catch (const ffe::ProtocolError& e) {
    // A broken stream cannot be resynchronised: report and exit so the host restarts us.
    std::fprintf(stderr, "frameflow-film: protocol error: %s\n", e.what());
    return 4;
  }
  return 0;
}

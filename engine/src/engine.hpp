// Request dispatcher: turns protocol frames into engine operations.
#pragma once
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>

#include "film_model.hpp"
#include "protocol.hpp"
#include "stock.hpp"

namespace ffe {

inline constexpr const char* kEngineVersion = "0.1.0";

class Engine {
 public:
  Engine(std::shared_ptr<const StockLibrary> stocks, unsigned threads);
  // Never throws: errors become {"ok":false,"error":{...}} responses.
  Frame handle(const Frame& request);
  bool shutdown_requested() const { return shutdown_; }

 private:
  Frame hello(const Json& req) const;
  Frame list_stocks(const Json& req) const;
  Frame bake_lut(const Json& req);
  Frame render(const Frame& req);
  std::shared_ptr<const FilmPipeline> pipeline(const Json& req);

  std::shared_ptr<const StockLibrary> stocks_;
  unsigned threads_;
  bool shutdown_ = false;
  std::mutex mu_;
  std::map<std::string, std::shared_ptr<const FilmPipeline>> pipelines_;
};

// Applies the pipeline to sRGB-encoded pixels in parallel (rows split across threads).
void run_parallel(std::size_t n, unsigned threads, const std::function<void(std::size_t, std::size_t)>& fn);

}  // namespace ffe

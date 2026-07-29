#!/usr/bin/env bash
#
# The git tag the podspec points at must be the tag the release actually creates.
#
# Through 0.1.2 the podspec interpolated `:tag => "#{s.version}"` — "0.1.2" —
# while Changesets tags releases as `<npm package name>@<version>`, i.e.
# `react-native-nitro-logger@0.1.2`. A CocoaPods consumer installing from git
# resolved a tag that had never existed, in any release.
#
# Two things this deliberately does NOT do:
#
#   * It does not `git rev-parse` the tag. Before publishing, the tag does not
#     exist yet — `changeset publish` creates it — so a resolve check could
#     only ever pass by accident on a re-run, and would fail on every genuine
#     release. What is checkable pre-publish is the STRING, and that is what
#     this compares.
#   * It does not regex the podspec. The tag expression contains nested quotes
#     (`"#{package["name"]}@#{s.version}"`), which a naive `[^"]*` truncates
#     mid-expression and then reports as a mismatch — a failure in the checker
#     that reads exactly like a failure in the podspec. Instead the podspec is
#     EVALUATED against a stub, so what is compared is the value CocoaPods
#     would really see.
#
# `s.name` is not the answer either: this pod is "NitroLogger" while the npm
# package, and therefore the tag, is "react-native-nitro-logger".
set -uo pipefail

cd "$(dirname "$0")/.."

if ! command -v ruby >/dev/null 2>&1; then
  echo "ruby is required to evaluate the podspec"
  exit 1
fi

PODSPEC="$(ls ./*.podspec 2>/dev/null | head -1)"
if [ -z "${PODSPEC:-}" ]; then
  echo "no podspec found"
  exit 1
fi

ruby - "$PODSPEC" <<'RUBY'
require "json"

podspec = ARGV[0]
package = JSON.parse(File.read("package.json"))
expected = "#{package["name"]}@#{package["version"]}"

# A stub that records what the podspec assigns, so the tag is the evaluated
# value rather than something scraped out of the text. Classic method syntax
# throughout: macOS ships Ruby 2.6, which cannot parse endless methods.
class SpecStub
  attr_accessor :name, :version, :source, :summary, :homepage, :license,
                :authors, :platforms, :source_files, :dependency_list

  def initialize
    @dependency_list = []
  end

  def dependency(*args)
    @dependency_list << args
  end

  # Anything not named above — `pod_target_xcconfig`, `compiler_flags`, the
  # nitrogen autolinking helper's various config hashes — answers with a fresh
  # Hash so `s.whatever["KEY"] = value` works. Returning nil makes the podspec
  # blow up inside a helper, which looks like a podspec fault rather than a
  # gap in this stub.
  def method_missing(_name, *_args)
    {}
  end

  def respond_to_missing?(*)
    true
  end
end

module Pod
  class Spec
    def self.new
      stub = SpecStub.new
      yield stub
      stub
    end
  end

  # The nitrogen autolinking helper the podspec requires prints through Pod::UI.
  module UI
    def self.puts(*_args); end
    def self.warn(*_args); end
    def self.message(*_args); end
  end
end

# The podspec calls these helpers from react-native's scripts; stub them so it
# evaluates standalone.
def min_ios_version_supported
  "15.1"
end

def install_modules_dependencies(*_args)
  nil
end

spec = eval(File.read(podspec), binding, podspec)

tag = spec.source && spec.source[:tag]
puts "  podspec :tag  -> #{tag.inspect}"
puts "  release tag   -> #{expected.inspect}"

if tag.nil?
  puts "FAIL: the podspec sets no :tag"
  exit 1
end

# The version must also be the one about to ship, or the string matches a tag
# for some other release.
unless tag.include?(package["version"])
  puts "FAIL: the tag does not carry the version being released"
  exit 1
end

if tag == expected
  puts "ok:   the podspec points at the tag this release will create"
  exit 0
end

puts "FAIL: a CocoaPods consumer installing from git would resolve a tag that"
puts "      does not exist. Changesets creates <npm name>@<version>."
exit 1
RUBY

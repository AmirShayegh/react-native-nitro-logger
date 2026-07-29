require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "NitroLogger"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  # Changesets tags releases as `<npm package name>@<version>`, so a bare
  # version names a tag that has never existed — a CocoaPods consumer
  # installing from git resolved nothing through 0.1.2. The name has to come
  # from package.json, not from `s.name`: this pod is "NitroLogger" while the
  # npm package, and therefore the tag, is "react-native-nitro-logger".
  s.source       = { :git => "https://github.com/AmirShayegh/react-native-nitro-logger.git", :tag => "#{package["name"]}@#{s.version}" }

  s.source_files = [
    "ios/**/*.{swift}",
    "ios/**/*.{m,mm}",
    "cpp/**/*.{hpp,cpp}",
  ]

  s.dependency 'React-jsi'
  s.dependency 'React-callinvoker'

  load 'nitrogen/generated/ios/NitroLogger+autolinking.rb'
  add_nitrogen_files(s)

  install_modules_dependencies(s)
end

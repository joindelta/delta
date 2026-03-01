#!/bin/bash
set -e

# Build script for Delta Core Android library

echo "Building Delta Core for Android..."

cd "$(dirname "$0")"

# Clean previous build to ensure changes are included
cargo clean

# Build host dylib first — used to generate Kotlin bindings with matching checksums
echo "Building host library for binding generation..."
cargo build --release

# Regenerate Kotlin bindings from the compiled host library so checksums match the .so
echo "Regenerating Kotlin bindings..."
rm -rf /tmp/uniffi_kotlin_out
uniffi-bindgen generate --library target/release/libdelta_core.dylib \
  --language kotlin --out-dir /tmp/uniffi_kotlin_out --no-format
cp /tmp/uniffi_kotlin_out/uniffi/delta_core/delta_core.kt \
  ../app/android/app/src/main/java/uniffi/delta_core/delta_core.kt

# Build for ARM64 (most modern Android devices)
echo "Building for aarch64-linux-android..."
cargo build --release --target aarch64-linux-android

# Build for x86_64 (Android emulator)
echo "Building for x86_64-linux-android..."
cargo build --release --target x86_64-linux-android

# Copy to Android app
echo "Copying libraries to Android app..."
cp target/aarch64-linux-android/release/libdelta_core.so ../app/android/app/src/main/jniLibs/arm64-v8a/
cp target/x86_64-linux-android/release/libdelta_core.so ../app/android/app/src/main/jniLibs/x86_64/

echo "Build complete!"
echo ""
echo "Next steps:"
echo "1. cd ../app/android"
echo "2. ./gradlew assembleDebug"
echo "3. Install the APK to your device/emulator"

#!/bin/bash
# Fix for missing dylib symlinks in embedded-postgres on darwin-arm64
TARGET_DIR="node_modules/.pnpm/@embedded-postgres+darwin-arm64*/node_modules/@embedded-postgres/darwin-arm64/native/lib"

for dir in $TARGET_DIR; do
  if [ -d "$dir" ]; then
    echo "Fixing embedded-postgres dylib symlinks in $dir..."
    # Execute within a subshell to avoid affecting the directory context
    (
      cd "$dir" || exit
      
      # Explicit fixes for specific postgres binary requirements
      [ -f libicudata.77.1.dylib ] && [ ! -e libicudata.77.dylib ] && ln -s libicudata.77.1.dylib libicudata.77.dylib
      [ -f libicuuc.77.1.dylib ] && [ ! -e libicuuc.77.dylib ] && ln -s libicuuc.77.1.dylib libicuuc.77.dylib
      [ -f libicui18n.77.1.dylib ] && [ ! -e libicui18n.77.dylib ] && ln -s libicui18n.77.1.dylib libicui18n.77.dylib
      [ -f libicui18n.77.1.dylib ] && [ ! -e libicui18n.dylib ] && ln -s libicui18n.77.1.dylib libicui18n.dylib
      
      [ -f libzstd.1.5.7.dylib ] && [ ! -e libzstd.1.dylib ] && ln -s libzstd.1.5.7.dylib libzstd.1.dylib
      [ -f liblz4.1.10.0.dylib ] && [ ! -e liblz4.1.dylib ] && ln -s liblz4.1.10.0.dylib liblz4.1.dylib
      [ -f libz.1.3.1.dylib ] && [ ! -e libz.1.dylib ] && ln -s libz.1.3.1.dylib libz.1.dylib
      
      # Catch-all for any other .1.*.dylib missing their .1.dylib symlink
      for f in *.dylib; do
        base=$(echo "$f" | grep -o -E '^[^.]+\.[0-9]+')
        if [ ! -z "$base" ] && [ ! -e "$base.dylib" ]; then
          ln -s "$f" "$base.dylib"
        fi
      done
    )
    echo "Done linking dylibs."
  fi
done

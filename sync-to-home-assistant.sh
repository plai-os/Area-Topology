#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: sh sync-to-home-assistant.sh /path/to/home-assistant/config" >&2
  exit 2
fi

ha_config_dir=${1%/}
if [ ! -d "$ha_config_dir" ]; then
  echo "Home Assistant config directory not found: $ha_config_dir" >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$ha_config_dir/www"
cp "$script_dir/area-topology-card.js" "$ha_config_dir/www/area-topology-card.js"
echo "Updated $ha_config_dir/www/area-topology-card.js"

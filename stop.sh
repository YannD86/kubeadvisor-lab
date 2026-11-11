#!/usr/bin/env bash
fuser -k "${LAB_WEB_PORT:-10200}/tcp" 2>/dev/null
fuser -k "${LAB_API_PORT:-10201}/tcp" 2>/dev/null
echo "stopped web and api (the kind cluster keeps running; use cluster/down.sh to delete it)"

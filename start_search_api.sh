#!/usr/bin/bash

chdir $(dirname $0)
export PYTHONPATH=./src
exec uvicorn search_api:app --reload --host 0.0.0.0


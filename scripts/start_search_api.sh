#!/usr/bin/bash

cd $(dirname $0)/..
PYTHONPATH=./src/backend uvicorn backend.search_api:app --reload --host 0.0.0.0


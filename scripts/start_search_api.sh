#!/usr/bin/bash

cd $(dirname $0)/..
source ./.venv/bin/activate
PYTHONPATH=./src uvicorn backend.search_api:app --reload --host 0.0.0.0


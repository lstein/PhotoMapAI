#!/usr/bin/bash

chdir $(dirname $0)
PYTHONPATH=./src uvicorn search_api:app --reload --host 0.0.0.0


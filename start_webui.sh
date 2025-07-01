#!/usr/bin/bash

chdir $(dirname $0)
PYTHONPATH=./src uvicorn web_ui:app --reload --host 0.0.0.0 --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem



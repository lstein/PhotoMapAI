#!/usr/bin/bash

cd $(dirname $0)/..
PYTHONPATH=./src \
	  uvicorn frontend.slideshow_server:app --reload \
	  --host 0.0.0.0 \
	  --port 8050 \
	  --ssl-keyfile src/frontend/certs/key.pem \
	  --ssl-certfile src/frontend/certs/cert.pem



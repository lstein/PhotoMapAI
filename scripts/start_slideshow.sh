#!/usr/bin/bash

cd $(dirname $0)/..
uvicorn clipslide.frontend.slideshow_server:app --reload \
	  --host 0.0.0.0 \
	  --port 8050 \
	  --ssl-keyfile clipslide/frontend/certs/key.pem \
	  --ssl-certfile clipslide/frontend/certs/cert.pem



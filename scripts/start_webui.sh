#!/usr/bin/bash

cd $(dirname $0)/..
PYTHONPATH=./src/frontend \
	  EMBEDDINGS_FILE=/net/cubox/CineRAID/Archive/InvokeAI/embeddings.npz \
	  uvicorn web_ui:app --reload \
	  --host 0.0.0.0 \
	  --port 8050 \
	  --ssl-keyfile src/frontend/certs/key.pem \
	  --ssl-certfile src/frontend/certs/cert.pem



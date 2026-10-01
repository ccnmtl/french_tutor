#!/usr/bin/env bash

./ve/bin/gunicorn french_tutor.asgi:application \
         --worker-class asgi --bind 0.0.0.0 --port 8000

# Use the official Python base image.
# List of public images from AWS can be located here:
#   https://gallery.ecr.aws/docker/library/python
FROM public.ecr.aws/docker/library/python:3.14-slim-trixie

RUN apt-get update && \
     apt-get install -y portaudio19-dev

# Set the working directory in the container
WORKDIR /app

RUN mkdir -p /tmp && chmod 1777 /tmp

COPY requirements.txt .
COPY requirements/ ./requirements/

# Upgrade pip
RUN python -m venv ve
RUN ./ve/bin/pip install --upgrade pip

# Install dependencies
RUN ./ve/bin/pip install --no-cache-dir -r requirements.txt

COPY . .
RUN rm -rf data/ *.dev.yml .env .dockerignore
RUN mkdir -p /var/log/django

EXPOSE 8000

RUN adduser --system --group django

RUN chown -R django:django /app /var/log/django

USER django

RUN chmod u+x entrypoint.sh
CMD ["./entrypoint.sh"]

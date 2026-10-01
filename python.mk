VE ?= ./ve
REQUIREMENTS ?= requirements.txt
SYS_PYTHON ?= python
PY_SENTINAL ?= $(VE)/sentinal
PIP ?= $(VE)/bin/pip
PYTHON ?= $(VE)/bin/python
FLAKE8 ?= $(VE)/bin/flake8

FLAKE8_VERSION ?= 7.4.1

INTERFACE ?= 127.0.0.1
LOAD_ENV = set -a && . ./.env && set +a

$(PY_SENTINAL): $(REQUIREMENTS)
	rm -rf $(VE)
	$(SYS_PYTHON) -m venv $(VE)
	$(PIP) install --upgrade pip
	$(PIP) install --requirement $(REQUIREMENTS)
	$(PIP) install flake8==$(FLAKE8_VERSION)
	touch $@

flake8: $(PY_SENTINAL)
	$(FLAKE8)

clean:
	rm -rf $(VE)
	rm -rf node_modules
	rm -rf static/dist
	find . -name '*.pyc' -exec rm {} \;

.PHONY: flake8 migrate verify runserver shell clean

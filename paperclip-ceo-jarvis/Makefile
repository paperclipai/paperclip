.PHONY: dev api frontend docker smoke clean

api:
	cd backend && uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

frontend:
	cd frontend && python -m http.server 5173

dev:
	@echo "Run 'make api' and 'make frontend' in separate terminals."

docker:
	docker compose up --build

smoke:
	DATABASE_URL=sqlite:////tmp/jarvis_v5_smoke.db backend/.venv/bin/python tests/smoke_test.py
	backend/.venv/bin/python tests/jarvis2_ui_test.py

clean:
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -f backend/jarvis.db

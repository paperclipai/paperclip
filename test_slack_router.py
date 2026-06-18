import sys
sys.path.insert(0, '/home/dwizy/architect-os/scripts')
from slack_router import route, Lane, Severity

print("Routing a test warning to INFRA...")
try:
    route(Lane.INFRA, Severity.WARN, "[VELOCITY/gap-test] Q3 Velocity Tracker test message.")
    print("Test warning routed successfully!")
except Exception as e:
    print(f"Error: {e}")
"""Auth routes — DEPRECATED in v3.0.

Custom email/password auth is replaced by Clerk hosted UI. These routes
return HTTP 410 Gone with a pointer to the Clerk SignIn URL so old extension
clients (still on v2.6.x) get a clear signal to update.

This file will be deleted in v3.0.4 once all users have migrated. For now
it stays so app.py blueprint registration doesn't break.
"""
from flask import Blueprint, jsonify

auth_bp = Blueprint("auth", __name__)


_GONE_RESPONSE = {
    "error": "This endpoint has been replaced by Clerk hosted authentication.",
    "code": "CLERK_MIGRATION",
    "hint": "Update the Toca Ficha Dr. extension to v3.0+ and sign in via the popup.",
}


@auth_bp.route("/auth/register", methods=["POST"])
def register():
    return jsonify(_GONE_RESPONSE), 410


@auth_bp.route("/auth/login", methods=["POST"])
def login():
    return jsonify(_GONE_RESPONSE), 410


@auth_bp.route("/auth/refresh", methods=["POST"])
def refresh():
    return jsonify(_GONE_RESPONSE), 410

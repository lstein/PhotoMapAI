"""
This module provides utility functions for the PhotoMap application."""

import socket


def get_public_ip_and_hostname():
    try:
        # This does not actually connect to 8.8.8.8, just figures out the outbound interface
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
        try:
            hostname = socket.gethostbyaddr(ip)[0]
        except Exception:
            hostname = None
        return ip, hostname
    except Exception:
        return None, None


def get_app_url(host: str, port: int) -> str:
    """Get the URL to access the app based on environment variables and network configuration."""
    ip, hostname = get_public_ip_and_hostname()
    if host == "0.0.0.0":
        if ip:
            if hostname and hostname != ip:
                url = f"http://{hostname}:{port} (or http://{ip}:{port})"
            else:
                url = f"http://{ip}:{port}"
        else:
            url = f"http://127.0.0.1:{port}"
    else:
        url = f"http://{host}:{port}"
    return url

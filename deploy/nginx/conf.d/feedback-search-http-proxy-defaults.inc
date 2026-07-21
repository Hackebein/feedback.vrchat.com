# Dynamic API JSON: disallow shared caching downstream; tighten response framing.
add_header Cache-Control "no-store" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;

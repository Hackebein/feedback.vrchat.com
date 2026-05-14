# Public REST surface: allow scripted or third-party tooling to call POST /api/search.
add_header Access-Control-Allow-Origin * always;
add_header Access-Control-Allow-Methods "GET, POST, OPTIONS, HEAD" always;
add_header Access-Control-Allow-Headers "Authorization, Content-Type, Accept, X-Requested-With" always;

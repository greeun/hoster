name: hoster deploy

on:
  push:
    branches: ["{{BRANCH}}"]

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            {{IMAGE_REPO}}:${{ github.sha }}
            {{IMAGE_REPO}}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Notify hoster deployer
        env:
          DEPLOY_URL: ${{ secrets.HOSTER_DEPLOY_URL }}
          DEPLOY_SECRET: ${{ secrets.HOSTER_DEPLOY_SECRET }}
        run: |
          BODY=$(printf '{"project":"%s","image":"%s","sha":"%s"}' \
            "{{PROJECT}}" \
            "{{IMAGE_REPO}}:${{ github.sha }}" \
            "${{ github.sha }}")
          TS=$(date +%s000)
          SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$DEPLOY_SECRET" -hex | awk '{print $NF}')
          HTTP_CODE=$(curl -s -o /tmp/resp.txt -w '%{http_code}' -X POST "$DEPLOY_URL/deploy" \
            -H "content-type: application/json" \
            -H "x-hoster-timestamp: $TS" \
            -H "x-hoster-signature: $SIG" \
            -d "$BODY" --max-time 300)
          cat /tmp/resp.txt
          [ "$HTTP_CODE" = "200" ] || exit 1

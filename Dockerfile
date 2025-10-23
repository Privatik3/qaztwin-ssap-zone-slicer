# ================================
# Build Stage - Node.js and Blender build environment
# ================================
# syntax=docker/dockerfile:1.6
FROM node:22 AS node-builder

# Copy package files for dependency installation
WORKDIR /app
COPY package.json ./
RUN npm install --production=false && npm cache clean --force

# Copy source files
COPY src/ ./src/

# ================================
# Blender Build Stage
# ================================
FROM ubuntu:22.04 AS blender-builder

# Set environment variables
ENV DEBIAN_FRONTEND=noninteractive
ENV BUILD_DIR=/build

# Workaround intermittent DNS resolution failures in some build environments
# Ensure reliable resolvers before any network operations
RUN printf "nameserver 1.1.1.1\nnameserver 8.8.8.8\nnameserver 208.67.222.222\n" > /etc/resolv.conf || true

# Install basic dependencies (cached layer) with better error handling
RUN apt-get update --fix-missing && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    git \
    git-lfs \
    wget \
    curl \
    ca-certificates \
    software-properties-common \
    build-essential \
    cmake \
    ninja-build \
    subversion \
    ccache \
    pkg-config \
    sudo \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR $BUILD_DIR

# Copy and extract Blender sources from local archive
COPY blender.tar.gz $BUILD_DIR/blender.tar.gz
RUN tar -xzf $BUILD_DIR/blender.tar.gz -C $BUILD_DIR && \
    mv $BUILD_DIR/blender $BUILD_DIR/blender-git && \
    rm $BUILD_DIR/blender.tar.gz
WORKDIR $BUILD_DIR/blender-git

# Install minimal system dependencies via Blender script (no --all to avoid distro mismatches)
RUN printf "nameserver 1.1.1.1\nnameserver 8.8.8.8\nnameserver 208.67.222.222\n" > /etc/resolv.conf || true && \
    apt-get update --fix-missing && \
    python3 build_files/build_environment/install_linux_packages.py || true

# Update and download precompiled libraries (cached layer)
# Download precompiled libraries (recommended path) only if missing
RUN printf "nameserver 1.1.1.1\nnameserver 8.8.8.8\nnameserver 208.67.222.222\n" > /etc/resolv.conf || true && \
    if [ ! -d lib/linux_x64 ]; then \
      echo "Precompiled libs missing, running make update"; \
      make update; \
    else \
      echo "Precompiled libs found, skipping make update"; \
    fi

# Build Blender (this takes the longest, cached when possible)
RUN make ccache
RUN --mount=type=cache,target=/root/.ccache make -j$(nproc)

# ================================
# Runtime Stage - Node.js 22 + Blender runtime environment
# ================================
FROM ubuntu:22.04

# Set environment variables
ENV DEBIAN_FRONTEND=noninteractive
ENV WORKDIR=/workspace
ENV BLENDER_PATH=/opt/blender/blender
ENV NVM_DIR=/root/.nvm
ENV NODE_VERSION=22
ENV PATH=$NVM_DIR/versions/node/v$NODE_VERSION/bin:$PATH

# Install minimal runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    curl \
    ca-certificates \
    wget \
    libsm6 \
    libice6 \
    libx11-6 \
    libxext6 \
    libgl1-mesa-glx \
    libgl1-mesa-dri \
    libegl1-mesa \
    libgles2-mesa \
    libglu1-mesa \
    libxi6 \
    libxrender1 \
    libxss1 \
    libxcursor1 \
    libxcomposite1 \
    libasound2 \
    libpulse0 \
    libxrandr2 \
    libxdamage1 \
    libxinerama1 \
    libgtk-3-0 \
    libgdk-pixbuf2.0-0 \
    libcairo-gobject2 \
    libpango-1.0-0 \
    libatk1.0-0 \
    libcairo2 \
    && rm -rf /var/lib/apt/lists/*

# Install nvm and Node.js 22
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash \
    && . "$NVM_DIR/nvm.sh" \
    && nvm install ${NODE_VERSION} \
    && nvm alias default ${NODE_VERSION} \
    && nvm use default

# Create necessary directories
RUN mkdir -p /opt/blender /workspace /workspace/data

# Copy Blender from blender-builder stage
COPY --from=blender-builder /build/bin /opt/blender
COPY --from=blender-builder /build/blender-git/lib /opt/blender/lib

# Copy Python scripts first
COPY scripts/ /workspace/scripts/

# Copy Node.js application from node-builder stage
COPY --from=node-builder /app /workspace

# Make Blender executable
RUN chmod +x $BLENDER_PATH

# Set working directory
WORKDIR $WORKDIR

# Create entrypoint script
RUN echo '#!/bin/bash\n\
set -e\n\
echo "🚀 Starting 3D Zone Slicer API Server with Node.js $NODE_VERSION"\n\
\n\
# Source nvm and set up Node.js environment\n\
export NVM_DIR=/root/.nvm\n\
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"\n\
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"\n\
\n\
# Execute the command passed to the container\n\
exec "$@"\n\
' > /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh

# Set entrypoint and default command
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]

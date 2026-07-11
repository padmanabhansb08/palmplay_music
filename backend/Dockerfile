FROM python:3.10-slim

WORKDIR /app

# Install system dependencies needed for some python packages
RUN apt-get update && apt-get install -y \
    build-essential \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY . .

# Expose port (Render/Railway sets PORT environment variable)
ENV PORT=8000
EXPOSE 8000

# Start FastAPI server
CMD uvicorn server:app --host 0.0.0.0 --port $PORT

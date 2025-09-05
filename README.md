# 3D Zone Slicer API

A Node.js API for 3D model processing with Blender - extracts blocks from GLB files and optimizes textures.

## Quick Start

### Run with Docker

```bash
# Build and run
docker-compose up --build

# Server will be available at http://localhost:5000
```

### Health Check

```bash
curl http://localhost:5000/health
```

## API Usage

### Endpoint

```
POST http://localhost:5000/zone-preview
```

### Required Parameters

- `blockPositionX` (number): X position relative to mesh center
- `blockPositionY` (number): Y position relative to mesh center
- `blockSizeX` (number): Block width (positive)
- `blockSizeY` (number): Block height (positive)
- `blockRotationZ` (number): Rotation angle in degrees
- `textureTargetResolution` (number): Target texture resolution in pixels
- `inputFileName` (string): Input GLB filename in `/workspace/data/`
- `outputFilePath` (string): Output path ending with `.glb`
- `enableDracoCompression` (boolean): Enable/disable Draco compression

### Example Request

```bash
curl -X POST http://localhost:4103/zone-preview \
  -H "Content-Type: application/json" \
  -d '{
    "blockPositionX": 0,
    "blockPositionY": 0,
    "blockSizeX": 20,
    "blockSizeY": 20,
    "blockRotationZ": 45,
    "textureTargetResolution": 4096,
    "inputFileName": "source.glb",
    "outputFilePath": "output/block.glb",
    "enableDracoCompression": true
  }'
```

### Success Response

```json
{
  "success": true,
  "data": {
    "outputFiles": [
      {
        "filename": "block.glb",
        "size": 1048576,
        "path": "/workspace/data/output/block.glb"
      }
    ]
  }
}
```

## File Structure

- Input files: Place GLB files in `/workspace/data/`
- Output files: Generated in specified output paths
- Scripts: Python processing scripts in `/workspace/scripts/`
- Config: Server configuration in `/workspace/src/`

## Environment Variables

- `PORT`: Server port (default: 5000)
- `BASE_DIR`: Data directory (default: `./data`)
- `PROCESS_TIMEOUT_MS`: Processing timeout (default: 300000ms)

## Notes

- Draco compression uses optimized fixed settings (Level 6)
- Texture resolution will be scaled down to target size if larger
- Block extraction preserves hollow interiors
- Processing timeout: 5 minutes default

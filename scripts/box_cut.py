#!/usr/bin/env python3
"""
Block Cutting + Texture Optimization at 4096px Resolution
Combines block extraction from complete_pipeline.py with texture optimization
"""
import bpy
import sys
import os
import subprocess
import time
import mathutils
import math
import bmesh

# === GLOBAL CONFIGURATION ===
# Read configuration from environment variables with defaults
import os

ENABLE_DRACO_COMPRESSION = os.getenv('ENABLE_DRACO_COMPRESSION', 'false').lower() == 'true'
DRACO_COMPRESSION_LEVEL = int(os.getenv('DRACO_COMPRESSION_LEVEL', '6'))
DRACO_POSITION_QUANTIZATION = int(os.getenv('DRACO_POSITION_QUANTIZATION', '14'))
DRACO_NORMAL_QUANTIZATION = int(os.getenv('DRACO_NORMAL_QUANTIZATION', '10'))
DRACO_TEXCOORD_QUANTIZATION = int(os.getenv('DRACO_TEXCOORD_QUANTIZATION', '18'))
DRACO_COLOR_QUANTIZATION = int(os.getenv('DRACO_COLOR_QUANTIZATION', '10'))
DRACO_GENERIC_QUANTIZATION = int(os.getenv('DRACO_GENERIC_QUANTIZATION', '12'))

# Texture optimization settings
TEXTURE_TARGET_RESOLUTION = int(os.getenv('TEXTURE_TARGET_RESOLUTION', '4096'))

# Block extraction settings
ENABLE_BLOCK_CUTTING = os.getenv('ENABLE_BLOCK_CUTTING', 'true').lower() == 'true'
BLOCK_POSITION_X = float(os.getenv('BLOCK_POSITION_X', '0'))      # X of the block centre, world coords
BLOCK_POSITION_Y = float(os.getenv('BLOCK_POSITION_Y', '0'))      # Y of the block centre, world coords
# Deployment-level shift of every block, mirroring the frontend's VITE_WORK_ZONE_BOX_OFFSET
# (used when the work-zone coordinates in the DB predate the current source.glb).
# X maps 1:1; Y is the NEGATED three.js Z, so VITE_..._OFFSET_Z=-4 means BLOCK_OFFSET_Y=+4.
BLOCK_OFFSET_X = float(os.getenv('BLOCK_OFFSET_X', '0'))
BLOCK_OFFSET_Y = float(os.getenv('BLOCK_OFFSET_Y', '0'))
# Some exports (DJI Terra) carry the WRONG sign of the Y-up axis conversion in their root nodes and
# render upside down; the viewer fixes that with rotation.x = PI. Set this when the viewer does.
MODEL_FLIP_X = os.getenv('MODEL_FLIP_X', 'false').lower() == 'true'
BLOCK_SIZE_X = float(os.getenv('BLOCK_SIZE_X', '20'))          # X dimension of block
BLOCK_SIZE_Y = float(os.getenv('BLOCK_SIZE_Y', '20'))          # Y dimension of block
BLOCK_ROTATION_Z = float(os.getenv('BLOCK_ROTATION_Z', '45'))      # Rotation around Z-axis in degrees

# File paths
INPUT_FILE_PATH = os.getenv('INPUT_FILE_PATH', '/workspace/data/source.glb')
OUTPUT_FILE_PATH = os.getenv('OUTPUT_FILE_PATH', '/workspace/data/output.glb')

# === END CONFIGURATION ===

def clear_scene():
    """Clear all objects from the current scene"""
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for mesh in bpy.data.meshes:
        bpy.data.meshes.remove(mesh)
    for material in bpy.data.materials:
        bpy.data.materials.remove(material)
    for texture in bpy.data.textures:
        bpy.data.textures.remove(texture)

def import_glb_file(file_path):
    """Import GLB file and return the main mesh object"""
    original_size = os.path.getsize(file_path)
    print(f"INPUT: {os.path.basename(file_path)} ({original_size/1024/1024:.1f}MB)")

    bpy.ops.import_scene.gltf(filepath=file_path)

    mesh_objects = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    if mesh_objects:
        # A photogrammetry export arrives as many tiled meshes, and the glTF importer keeps the
        # Y-up -> Z-up conversion on the PARENT nodes (the meshes' own transforms are identity, so
        # transform_apply alone is a no-op). The cuts below run on local mesh data of ONE object,
        # so without this both the axes and the coverage are wrong.
        bpy.ops.object.select_all(action='DESELECT')
        for o in mesh_objects:
            o.select_set(True)
        bpy.context.view_layer.objects.active = mesh_objects[0]
        bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True, isolate_users=True)
        if len(mesh_objects) > 1:
            bpy.ops.object.join()
            print(f"JOIN: {len(mesh_objects)} meshes -> 1")
        obj = bpy.context.view_layer.objects.active
        # Put the mesh in the same frame the viewer shows, because the block coordinates are the
        # ones the UI used to place its box: undo the wrong-signed axis conversion if the viewer
        # does (a three.js 180 deg turn about X is the same about X here), then centre in XY the
        # way the viewer centres in XZ. Z (height) is left alone — the block spans it whole.
        if MODEL_FLIP_X:
            obj.data.transform(mathutils.Matrix.Rotation(math.pi, 4, 'X'))
        center, _ = get_mesh_center_and_dimensions(obj)
        obj.data.transform(mathutils.Matrix.Translation((-center.x, -center.y, 0)))
        obj.data.update()
        print(f"FRAME: flip_x={MODEL_FLIP_X} centred by {(-round(center.x, 2), -round(center.y, 2))}")
        print(f"MESH: {len(obj.data.vertices):,} vertices, {len(obj.data.polygons):,} faces")
        return obj
    return None

def analyze_texture(obj):
    """Analyze texture information"""
    for slot in obj.material_slots:
        if slot.material and slot.material.node_tree:
            for node in slot.material.node_tree.nodes:
                if node.type == 'TEX_IMAGE' and node.image:
                    image = node.image
                    size_bytes = len(image.pixels) * 4
                    print(f"TEXTURE: {image.name} {image.size[0]}x{image.size[1]} ({size_bytes/1024:.0f}KB)")
                    return image.size[:]

def optimize_texture_4096(obj):
    """Optimize texture to target resolution"""
    for slot in obj.material_slots:
        if slot.material and slot.material.node_tree:
            for node in slot.material.node_tree.nodes:
                if node.type == 'TEX_IMAGE' and node.image:
                    image = node.image
                    original_size = image.size[:]
                    max_dim = max(original_size)

                    if max_dim > TEXTURE_TARGET_RESOLUTION:
                        print(f"SCALE: {original_size[0]}x{original_size[1]} → {TEXTURE_TARGET_RESOLUTION}x{TEXTURE_TARGET_RESOLUTION}")
                        image.scale(TEXTURE_TARGET_RESOLUTION, TEXTURE_TARGET_RESOLUTION)
                        if not image.packed_file:
                            image.pack()
                        return True
                    else:
                        print(f"KEEP: {original_size[0]}x{original_size[1]} (already <= {TEXTURE_TARGET_RESOLUTION}px)")
                        return True
    return False

def export_glb_optimized(obj, output_path):
    """Export GLB with optimized settings and configurable Draco compression"""
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    try:
        export_params = {
            'filepath': output_path,
            'export_format': 'GLB',
            'use_selection': True,
        }

        # Add Draco compression settings if enabled
        if ENABLE_DRACO_COMPRESSION:
            export_params.update({
                'export_draco_mesh_compression_enable': True,
                'export_draco_mesh_compression_level': DRACO_COMPRESSION_LEVEL,
                'export_draco_position_quantization': DRACO_POSITION_QUANTIZATION,
                'export_draco_normal_quantization': DRACO_NORMAL_QUANTIZATION,
                'export_draco_texcoord_quantization': DRACO_TEXCOORD_QUANTIZATION,
                'export_draco_color_quantization': DRACO_COLOR_QUANTIZATION,
                'export_draco_generic_quantization': DRACO_GENERIC_QUANTIZATION
            })

        # Temporarily suppress Blender INFO logs
        import logging
        logging.basicConfig(level=logging.WARNING)

        bpy.ops.export_scene.gltf(**export_params)

        if os.path.exists(output_path):
            size = os.path.getsize(output_path)
            compression = f"DRACO L{DRACO_COMPRESSION_LEVEL}" if ENABLE_DRACO_COMPRESSION else "NO DRACO"
            print(f"OUTPUT: {os.path.basename(output_path)} ({size/1024/1024:.2f}MB) {compression}")
            return size
        else:
            print("ERROR: Export failed - file not created")
            return None
    except Exception as e:
        print(f"ERROR: Export failed - {str(e)}")
        return None

def get_mesh_center_and_dimensions(obj):
    """Centre and dimensions of the mesh bounding box, straight from the vertices.

    obj.bound_box is a cached value that does NOT refresh until the depsgraph re-evaluates, so it
    lies right after the mesh data is transformed in place — which is exactly when it is read here.
    """
    min_corner = mathutils.Vector((float('inf'), float('inf'), float('inf')))
    max_corner = mathutils.Vector((float('-inf'), float('-inf'), float('-inf')))

    for vert in obj.data.vertices:
        for i in range(3):
            min_corner[i] = min(min_corner[i], vert.co[i])
            max_corner[i] = max(max_corner[i], vert.co[i])

    return (min_corner + max_corner) / 2, max_corner - min_corner

def rotate_mesh_about_point(obj, pivot, rot_matrix):
    """Rotate mesh vertices around a pivot point."""
    bpy.ops.object.mode_set(mode='OBJECT')
    bm = bmesh.new()
    bm.from_mesh(obj.data)

    # Create the transformation matrix
    transform_matrix = (
        mathutils.Matrix.Translation(pivot) @
        rot_matrix @
        mathutils.Matrix.Translation(-pivot)
    )

    # Apply the transformation
    bmesh.ops.transform(bm, matrix=transform_matrix, verts=bm.verts)

    # Update the mesh and free the bmesh
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()

def extract_specific_block(obj, pos_x, pos_y, size_x, size_y, rot_z):
    """Extract a rotated block.

    pos_x / pos_y are the ABSOLUTE world coordinates of the block centre — the same placement the
    UI uses for the box mesh (three.js x -> x, three.js z -> -y), NOT an offset from the mesh
    centre. rot_z is the yaw the UI applies, in degrees; a +yaw about three.js Y is a +rotation
    about Blender Z, so the mesh is turned by -rot_z to make the block axis aligned. Rotating about
    the block centre itself keeps the pivot out of the arithmetic.
    """
    mesh_center, mesh_dimensions = get_mesh_center_and_dimensions(obj)
    size_z = mesh_dimensions.z  # Full mesh height — the caller has no Z inputs

    block_center_x = pos_x + BLOCK_OFFSET_X
    block_center_y = pos_y + BLOCK_OFFSET_Y
    block_center_z = mesh_center.z

    print(f"BLOCK: World({block_center_x},{block_center_y}) Size({size_x}x{size_y}) RotZ({rot_z})")

    # Ensure the object is single-user
    if obj.data.users > 1:
        obj.data = obj.data.copy()

    original_verts = len(obj.data.vertices)

    # Rotate the mesh around Z-axis
    pivot_center = mathutils.Vector((block_center_x, block_center_y, block_center_z))
    rotation_euler = mathutils.Euler((0, 0, math.radians(-rot_z)), 'XYZ')
    rotation_matrix = rotation_euler.to_matrix().to_4x4()

    rotate_mesh_about_point(obj, pivot_center, rotation_matrix)

    block_min_x = block_center_x - size_x / 2
    block_max_x = block_center_x + size_x / 2
    block_min_y = block_center_y - size_y / 2
    block_max_y = block_center_y + size_y / 2
    block_min_z = block_center_z - size_z / 2
    block_max_z = block_center_z + size_z / 2

    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT')

    # X-axis cuts
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.bisect(plane_co=(block_min_x, 0, 0), plane_no=(1, 0, 0), clear_inner=True)
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.bisect(plane_co=(block_max_x, 0, 0), plane_no=(1, 0, 0), clear_outer=True)

    # Y-axis cuts
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.bisect(plane_co=(0, block_min_y, 0), plane_no=(0, 1, 0), clear_inner=True)
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.bisect(plane_co=(0, block_max_y, 0), plane_no=(0, 1, 0), clear_outer=True)

    # Z-axis cuts
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.bisect(plane_co=(0, 0, block_min_z), plane_no=(0, 0, 1), clear_inner=True)
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.bisect(plane_co=(0, 0, block_max_z), plane_no=(0, 0, 1), clear_outer=True)

    bpy.ops.object.mode_set(mode='OBJECT')

    # Rotate the mesh back
    inverse_rotation_matrix = rotation_matrix.inverted()
    rotate_mesh_about_point(obj, pivot_center, inverse_rotation_matrix)

    # Clean up mesh
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.remove_doubles(threshold=0.0001)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')

    final_verts = len(obj.data.vertices)
    if original_verts > 0:
        vert_reduction = (1 - final_verts / original_verts) * 100
        print(f"MESH: {final_verts:,} vertices ({vert_reduction:.1f}% reduction)")

    return obj

def main():
    # Check source file
    if not os.path.exists(INPUT_FILE_PATH):
        print(f"ERROR: Source file not found: {INPUT_FILE_PATH}")
        sys.exit(1)

    # Clear separator for new script run
    print("\n" + "=" * 60)
    print("3D ZONE SLICER - BLENDER PROCESSOR")
    print("=" * 60)

    # Configuration summary
    config_lines = [
        f"CONFIG: Texture={TEXTURE_TARGET_RESOLUTION}px",
        f"CONFIG: Draco={'L' + str(DRACO_COMPRESSION_LEVEL) if ENABLE_DRACO_COMPRESSION else 'OFF'}",
    ]
    if ENABLE_BLOCK_CUTTING:
        config_lines.append(f"CONFIG: Block=({BLOCK_POSITION_X},{BLOCK_POSITION_Y}) {BLOCK_SIZE_X}x{BLOCK_SIZE_Y} RotZ{BLOCK_ROTATION_Z}")

    for line in config_lines:
        print(line)

    # Fresh import
    clear_scene()
    test_obj = import_glb_file(INPUT_FILE_PATH)
    if not test_obj:
        return

    # Analyze original texture
    print("PHASE 1: Original texture analysis")
    analyze_texture(test_obj)

    # Extract block if enabled
    if ENABLE_BLOCK_CUTTING:
        print("PHASE 2: Block extraction")
        test_obj = extract_specific_block(
            test_obj,
            BLOCK_POSITION_X, BLOCK_POSITION_Y,
            BLOCK_SIZE_X, BLOCK_SIZE_Y,
            BLOCK_ROTATION_Z
        )
        if not test_obj:
            print("ERROR: Block extraction failed!")
            return

    # Optimize texture
    print("PHASE 3: Texture optimization")
    optimized = optimize_texture_4096(test_obj)
    if not optimized:
        print("ERROR: No textures found to optimize")
        return

    # Export GLB
    print("PHASE 4: Export")
    glb_size = export_glb_optimized(test_obj, OUTPUT_FILE_PATH)

    if glb_size:
        original_size = os.path.getsize(INPUT_FILE_PATH)
        reduction = (1 - glb_size / original_size) * 100
        print(f"SUCCESS: {reduction:.1f}% size reduction")
    else:
        print("ERROR: Export failed")

    print("=" * 60)

if __name__ == "__main__":
    main()

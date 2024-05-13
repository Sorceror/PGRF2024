@group(0) @binding(0) var<uniform> gridSize : vec2f;

@group(0) @binding(1) var<storage> cellStateIn : array<u32>;
@group(0) @binding(2) var<storage, read_write> cellStateOut : array<u32>;

// Conversion from 2D coordinate to 1D array index
fn cellIndex(x : u32, y : u32) -> u32 {
    // Slightly different than usual 2D -> 1D index conversion to support wrap-around effect
    return (y % u32(gridSize.y)) * u32(gridSize.x) + (x % u32(gridSize.x));
}

// Return flag whether cell is alive on specific coordinate
fn cellActive(x : u32, y : u32) -> u32 {
    return cellStateIn[cellIndex(x, y)];
}

@compute
@workgroup_size(8, 8)
fn computeMain(@builtin(global_invocation_id) cell : vec3u) {
    // Evaluate alive neighbors count
    let activeNeighbors = cellActive(cell.x + 1, cell.y + 1) +
                            cellActive(cell.x + 1, cell.y    ) +
                            cellActive(cell.x + 1, cell.y - 1) +
                            cellActive(cell.x    , cell.y - 1) +
                            cellActive(cell.x - 1, cell.y - 1) +
                            cellActive(cell.x - 1, cell.y    ) +
                            cellActive(cell.x - 1, cell.y + 1) +
                            cellActive(cell.x    , cell.y + 1);
    let i = cellIndex(cell.x, cell.y);

    // Conway's game of life rules
    switch activeNeighbors {
        // Active cells with 2 neighbors stay active
        case 2u : {
            cellStateOut[i] = cellStateIn[i];
        }
        // Cells with 3 neighbors become or stay active
        case 3u : {
            cellStateOut[i] = 1u;
        }
        // Cells with < 2 or > 3 neighbors become inactive
        default : {
            cellStateOut[i] = 0u;
        }
    }
}

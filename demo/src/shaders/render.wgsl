struct VertexInput {
    @location(0) pos: vec2f,
    @builtin(instance_index) instance: u32,
};

struct VertexOutput {
    @builtin(position) pos: vec4f,
    @location(0) cell: vec2f,
};

@group(0) @binding(0) var<uniform> gridSize: vec2f;
@group(0) @binding(1) var<storage> cellState: array<u32>;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    let i = f32(input.instance);
    // 1D index -> 2D grid conversion
    let cellCoord = vec2f(i % gridSize.x, floor(i / gridSize.x));
    let state = f32(cellState[input.instance]);

    // Multiplied by 2 because we're working with range from -1 to 1 
    // not from 0 to 1 as gridSize is defined
    let cellOffset = cellCoord / gridSize * 2;
    // Move vertex to proper position if alive, otherwise to [0,0]
    // so it get's discarded by the pipeline later
    let gridPos = (input.pos * state + 1) / gridSize - 1 + cellOffset;

    var output: VertexOutput;
    output.pos = vec4f(gridPos, 0, 1);
    output.cell = cellCoord;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
    // Clamp color to range from 0 to 1
    let c = input.cell / gridSize;
    // Remap [0,0,1]->[1,1,1] to [0,1,1]->[1,0,1] to avoid black
    // and make it more interesting
    return vec4f(c, 1 - c.x, 1);
}
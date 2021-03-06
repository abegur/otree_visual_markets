import { html, PolymerElement } from '/static/otree-redwood/node_modules/@polymer/polymer/polymer-element.js';
import './lib/marchingsquares.js'
import './currency_scaler.js';

/**
 * utility function to map a value from one range to another
 *
 * @param {Number} value the value to be re-mapped
 * @param {Number} lo1 the low value of the range to be mapped from
 * @param {Number} hi1 the high value of the range to be mapped from
 * @param {Number} lo2 the low value of the range to be mapped to
 * @param {Number} hi2 the high value of the range to be mapped to
 */
const remap = (value, lo1, hi1, lo2, hi2) => {
    const t = (value - lo1) / (hi1 - lo1);
    return lo2 + t * (hi2 - lo2);
};

/**
 * utility function to contain a value within some bounds
 *
 * @param {Number} value the value to be clamped
 * @param {Number} min the min value of the clamping range
 * @param {Number} max the max value of the clamping range
 */
const clamp = (value, min, max) => {
    return Math.min(Math.max(value, min), max);
}

/**
 * `heatmap-element`
 * heatmap for oTree Visual Markets
 *
 * @customElement
 * @polymer
 * @demo demo/index.html
 */
class HeatmapElement extends PolymerElement {
    static get template() {
        return html`
            <style>
                :host {
                    display: block;
                    /* the width/height of the x and y axes */
                    --axis-size: 2em;
                    /* extra padding on the top/right of the heatmap to leave room for axis labels at extremes */
                    --axis-padding: 2em;
                }
                .main_container {
                    position: relative;
                    width: 100%;
                    height: 100%;
                }
                .main_container > :last-child {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                }
                #y_scale {
                    position: absolute;
                    width: var(--axis-size);
                    height: 100%;
                }
                #x_scale {
                    position: absolute;
                    top: calc(100% - var(--axis-size));
                    width: 100%;
                    height: var(--axis-size);
                }
                #heatmap_container {
                    top: var(--axis-padding);
                    left: var(--axis-size);
                    position: absolute;
                    width: calc(100% - var(--axis-size) - var(--axis-padding));
                    height: calc(100% - var(--axis-size) - var(--axis-padding));
                }
                #heatmap_container > canvas {
                    position: absolute;
                    width: 100%;
                    height: 100%;
                }
            </style>

            <currency-scaler
                id="currency_scaler"
            ></currency-scaler>
            
            <div class="main_container">
                <canvas id="y_scale"></canvas>
                <div id="heatmap_container" on-mousemove="hover" on-mouseout="mouseout" on-click="click">
                    <!-- use stacked canvases as 'layers' so we can clear different elements individually -->
                    <canvas id="heatmap_canvas"></canvas>
                    <canvas id="hover_curve_canvas"></canvas>
                    <canvas id="current_bundle_canvas"></canvas>
                    <canvas id="proposed_bundle_canvas"></canvas>
                </div>
                <canvas id="x_scale"></canvas>
                </div>
            </div>
        `;
    }

    static get properties() {
        return {
            colorScheme: {
                type: Array,
                value: () => [
                    [255, 255, 255],
                    [255, 0, 0],
                ],
            },
            utilityFunction: {
                type: Object,
            },
            heatmapEnabled: Boolean,
            proposedX: Number,
            proposedY: Number,
            xBounds: Array,
            yBounds: Array,
            currentX: Number,
            currentY: Number,
            maxUtility: Number,
            // the size in pixels of the grid that the indifference curves are evaluated over
            // a larger value is faster but results in blockier curves
            _quadTreeGridSize: {
                type: Number,
                value: 10,
            },
            quadTree: {
                type: Object,
                computed: 'computeQuadTree(_quadTreeGridSize, utilityFunction, xBounds, yBounds, width, height)',
            }
        }
    }

    static get observers() {
        return [
            'drawHeatmap(heatmapEnabled, utilityFunction, xBounds, yBounds, maxUtility, width, height)',
            'drawHoverCurve(mouseX, mouseY, currentX, currentY, utilityFunction, xBounds, yBounds, width, height, quadTree)',
            'drawCurrentBundle(currentX, currentY, utilityFunction, xBounds, yBounds, width, height, quadTree)',
            'drawProposedBundle(proposedX, proposedY, xBounds, yBounds, width, height)',
            'drawXAxis(xBounds, axisSize, axisPadding, width, height)',
            'drawYAxis(yBounds, axisSize, axisPadding, width, height)',
        ]
    }

    ready() {
        super.ready();
        const resizeObserver = new ResizeObserver(entries => {
            const containerChange = entries[0];
            const width = Math.floor(containerChange.contentRect.width);
            const height = Math.floor(containerChange.contentRect.height);
            this.setSize(width, height);
        });
        resizeObserver.observe(this.$.heatmap_container);
    }

    setSize(width, height) {
        // we have to update this.width and this.height after waiting, since for some reason updating the canvas' widths and heights
        // doesn't happen until the next tick. changing this.width and this.height after waiting ensures that the canvases have correct
        // width and height properties when the polymer observers are triggered
        for (const canvas of this.$.heatmap_container.querySelectorAll('canvas')) {
            canvas.width = width;
            canvas.height = height;
        }

        // set width and height properties on scale canvases
        this.$.x_scale.width = this.$.x_scale.clientWidth;
        this.$.x_scale.height = this.$.x_scale.clientHeight;
        this.$.y_scale.width = this.$.y_scale.clientWidth;
        this.$.y_scale.height = this.$.y_scale.clientHeight;

        // retrieve axis size and axis padding values
        // these should equal the --axis-size and --axis-padding css variables, converted to pixels
        this.axisSize = this.$.x_scale.height;
        this.axisPadding = this.$.heatmap_container.offsetTop;

        setTimeout(() => {
            this.setProperties({
                width: width,
                height: height,
            });
        });
    }

    /**
     * Draw an indifference curve for a given utility value
     * 
     * @param {Number} utility The utility value this indifference curve goes through
     * @param {CanvasRenderingContext2D} ctx A rendering context which is to be used to draw the curve
     * @param {MarchingSquaresJS.QuadTree} quadTree A quadtree object containing the utility data
     */
    drawIndifferenceCurve(utility, ctx, quadTree) {
        ctx.save();
        const gridSize = this._quadTreeGridSize;
        const paths = MarchingSquaresJS.isoLines(quadTree, utility, {noFrame: true});
        for (const path of paths) {
            ctx.beginPath();
            for (let i = 0; i < path.length; i++) {
                let [x, y] = path[i];
                x = -gridSize + x*gridSize;
                y = -gridSize + y*gridSize;
                if (i == 0) {
                    ctx.moveTo(x, y);
                }
                else {
                    ctx.lineTo(x, y);
                }
            }
            ctx.stroke();
        }
        ctx.restore();
    }

    /**
     * Update mouseX and mouseY variables. These variables are in 'screen coordinates', so their values
     * are in pixels and should be between 0 and width/height. Sometimes they'll be outside those bounds though
     * due to some weirdness with how mouseover works.
     * 
     * Throttle rate of update so hover curve update doesn't get called too frequently.
     * Not sure throttling is really required since curves are drawn pretty quickly, but it's
     * probably a good idea anyways.
     *
     * @param {*} e mousemove event
     */
    hover(e) {
        const now = performance.now();
        // throttle rate in ms
        // this value is the minimum amount of time between mouse updates
        const throttle_rate = 10;
        const updateMouse = () => {
            const boundingRect = this.$.heatmap_container.getBoundingClientRect();
            this.mouseX = e.clientX - boundingRect.left;
            this.mouseY = e.clientY - boundingRect.top;
            this.last_hover = now;
        }
        clearTimeout(this.hover_timeout);
        this.hover_timeout = setTimeout(updateMouse, this.last_hover + throttle_rate - now);
    }

    /**
     * Clear mouseX and mouseY variables when mouse leaves the heatmap
     */
    mouseout() {
        clearTimeout(this.hover_timeout);
        this.mouseX = null;
        this.mouseY = null;
    }

    click(e) {
        const requiredProperties = [this.xBounds, this.yBounds, this.width, this.height];
        if (requiredProperties.some(e => typeof e === 'undefined')) return;

        const boundingRect = this.$.heatmap_container.getBoundingClientRect();
        const screenX = e.clientX - boundingRect.left;
        const screenY = e.clientY - boundingRect.top;

        let x =  remap(screenX, 0, this.width, this.xBounds[0], this.xBounds[1]);
        x = clamp(Math.round(x), this.xBounds[0], this.xBounds[1]);
        let y = remap(screenY, 0, this.height, this.yBounds[1], this.yBounds[0]);
        y = clamp(Math.round(y), this.yBounds[0], this.yBounds[1]);

        this.dispatchEvent(new CustomEvent('heatmap-click', {
            detail: {x: x, y: y},
            bubbles: true,
            composed: true
        }));
    }

    drawHoverCurve(mouseX, mouseY, currentX, currentY, utilityFunction, xBounds, yBounds, width, height, quadTree) {
        // if any arguments are undefined, just return
        if (Array.from(arguments).some(e => typeof e === 'undefined')) return;

        const ctx = this.$.hover_curve_canvas.getContext('2d');
        ctx.clearRect(0, 0, width, height);
        // if mouse coordinates aren't defined, or are outside the screen bounds, just return after clearing the hover canvas
        if (mouseX === null || mouseY === null || mouseX < 0 || mouseX > width || mouseY < 0 || mouseY > height) {
            return;
        }

        const x = remap(mouseX, 0, width, xBounds[0], xBounds[1]);
        const y = remap(mouseY, 0, height, yBounds[1], yBounds[0]);

        // if mouse position is in one of the 'impossible' quadrants, just return
        if ((x < currentX && y < currentY) || (x > this.currentX && y > this.currentY)) {
            return;
        }

        const utility = utilityFunction(x, y);
        this.drawIndifferenceCurve(utility, ctx, quadTree);
    }

    drawCurrentBundle(currentX, currentY, utilityFunction, xBounds, yBounds, width, height, quadTree) {
        // if any arguments are undefined, just return
        if (Array.from(arguments).some(e => typeof e === 'undefined')) return;

        const ctx = this.$.current_bundle_canvas.getContext('2d');
        ctx.clearRect(0, 0, width, height);
        if (currentX < xBounds[0] || currentX > xBounds[1] || currentY < yBounds[0] || currentY > yBounds[1]) {
            return;
        }

        // draw indifference curve for current bundle
        const utility = utilityFunction(currentX, currentY);
        this.drawIndifferenceCurve(utility, ctx, quadTree);

        // the current bundle in screen coordinates
        const screenX = remap(currentX, xBounds[0], xBounds[1], 0, width);
        const screenY = remap(currentY, yBounds[1], yBounds[0], 0, height);

        // draw greyed-out squares for impossible trades
        ctx.beginPath()
        ctx.rect(screenX, 0, width-screenX, screenY);
        ctx.rect(0, screenY, screenX, height-screenY);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fill();

        // draw circle centered at current bundle
        ctx.beginPath();
        ctx.arc(screenX, screenY, 5, 0, 2*Math.PI);
        ctx.fillStyle = 'yellow';
        ctx.fill();
        ctx.stroke();
    }

    drawProposedBundle(proposedX, proposedY, xBounds, yBounds, width, height) {
        if (Array.from(arguments).some(e => typeof e === 'undefined')) return;

        const ctx = this.$.proposed_bundle_canvas.getContext('2d');
        ctx.clearRect(0, 0, width, height);

        if (proposedX === null || proposedX === null)
            return;

        const screenX = remap(proposedX, xBounds[0], xBounds[1], 0, width);
        const screenY = remap(proposedY, yBounds[1], yBounds[0], 0, height);

        ctx.beginPath();
        ctx.arc(screenX, screenY, 5, 0, 2*Math.PI);
        ctx.fillStyle = 'orange';
        ctx.fill();
        ctx.stroke();
    }

    /**
     * gets colors from the gradient defined by this.colorScheme
     * 0.0 <= percent <= 1.0
     * where percent = 1.0 gets the last color in color_stops and percent = 0.0 gets the first color in color_stops
     *
     * @param {*} percent value to get from gradient
     */
    getGradientColor(percent) {
        percent = clamp(percent, 0, 1);
        const scheme = this.colorScheme;
        percent = percent * (scheme.length - 1)
        const low_index = Math.floor(percent)
        const high_index = Math.ceil(percent)
        percent = percent - low_index
        return [0, 1, 2].map(i => percent * scheme[high_index][i] + (1 - percent) * scheme[low_index][i])
    }

    /**
     * Generate the heatmap
     */
    drawHeatmap(heatmapEnabled, utilityFunction, xBounds, yBounds, maxUtility, width, height) {
        // if any arguments are undefined, just return
        if (Array.from(arguments).some(e => typeof e === 'undefined')) return;

        if (!heatmapEnabled) return;

        const ctx = this.$.heatmap_canvas.getContext('2d');

        const imageData = ctx.createImageData(width, height);
        const data = imageData.data;
        // iterate through every pixel in the image in row major order
        for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
                const x = remap(col, 0, width, xBounds[0], xBounds[1]);
                const y = remap(row, 0, height, yBounds[1], yBounds[0]);
                const utility = utilityFunction(x, y);
                var percent = utility / maxUtility;

                const color = this.getGradientColor(percent);

                const index = (row * width * 4) + (col * 4);
                data[index    ] = color[0];
                data[index + 1] = color[1];
                data[index + 2] = color[2];
                // set alpha channel to fully opaque
                data[index + 3] = 255
            }
        }

        // Display heatmap
        ctx.putImageData(imageData, 0, 0);
    }

    // get an appropriate tick interval for an x or y axis given the bounds of that axis
    // intervals are chosen as 1, 2, 5 or a multiple of an appropriate power of 10
    getTickInterval(bounds) {
        const range = bounds[1] - bounds[0];
        const maxNumTicks = 20;
        for (const interval of [1, 2, 5]) {
            if (range / interval <= maxNumTicks) return interval;
        }
        let interval = 10;
        let base = 10;
        while (true) {
            for (let i = 0; i < 9; i++) {
                interval += base;
                if (range / interval <= maxNumTicks) return interval;
            }
            base *= 10;
        }
    }

    drawXAxis(xBounds, axisSize, axisPadding, _width, _height) {
        // _width and _height aren't used, they're just there so that the axes are redrawn when the size of the heatmap changes

        // if any arguments are undefined, just return
        if (Array.from(arguments).some(e => typeof e === 'undefined')) return;

        const width = this.$.x_scale.width;
        const height = this.$.x_scale.height;

        const ctx = this.$.x_scale.getContext('2d');
        ctx.textBaseline = 'top'
        ctx.beginPath();
        ctx.moveTo(axisSize-1, 1);
        ctx.lineTo(width-axisPadding, 1);

        const interval = this.getTickInterval(xBounds);
        let curTick = xBounds[0];
        while (curTick <= xBounds[1]) {
            const curTickPixels = remap(curTick, xBounds[0], xBounds[1], axisSize-1, width-axisPadding);
            ctx.moveTo(curTickPixels, 1);
            ctx.lineTo(curTickPixels, 10);
            const curTickText = this.$.currency_scaler.xToHumanReadable(curTick)
            ctx.fillText(curTickText, curTickPixels + 5, 5)
            curTick += interval;
        }

        ctx.stroke();
    }

    drawYAxis(yBounds, axisSize, axisPadding, _width, _height) {
        // _width and _height aren't used, they're just there so that the axes are redrawn when the size of the heatmap changes

        // if any arguments are undefined, just return
        if (Array.from(arguments).some(e => typeof e === 'undefined')) return;

        const width = this.$.y_scale.width;
        const height = this.$.y_scale.height;

        const ctx = this.$.y_scale.getContext('2d');
        ctx.textAlign = 'right';
        ctx.beginPath();
        ctx.moveTo(width-1, axisPadding);
        ctx.lineTo(width-1, height-axisSize+1);

        const interval = this.getTickInterval(yBounds);
        let curTick = yBounds[0];
        while (curTick <= yBounds[1]) {
            const curTickPixels = remap(curTick, yBounds[0], yBounds[1], height-axisSize+1, axisPadding);
            ctx.moveTo(width, curTickPixels);
            ctx.lineTo(width - 10, curTickPixels);
            const curTickText = this.$.currency_scaler.yToHumanReadable(curTick)
            ctx.fillText(curTickText, width-5, curTickPixels - 5)
            curTick += interval;
        }

        ctx.stroke();
    }

    computeQuadTree(gridSize, utilityFunction, xBounds, yBounds, width, height) {
        // if any arguments are undefined, just return
        if (Array.from(arguments).some(e => typeof e === 'undefined')) return;

        const data = [];
        for (let row = -gridSize; row < height+2*gridSize; row += gridSize) {
            data.push([]);
            for (let col = -gridSize; col < width+2*gridSize; col += gridSize) {
                let x = remap(col, 0, width,  xBounds[0], xBounds[1]);
                x = clamp(x, xBounds[0], xBounds[1]);
                let y = remap(row, 0, height, yBounds[1], yBounds[0])
                y = clamp(y, yBounds[0], yBounds[1]);

                const utility = utilityFunction(x, y);
                data[data.length-1].push(utility);
            }
        }
        return new MarchingSquaresJS.QuadTree(data);
    }
}

window.customElements.define('heatmap-element', HeatmapElement)
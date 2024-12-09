import React, { useState, useEffect } from 'react';

const Dishes = () => {
    const [dishes, setDishes] = useState([]);

    useEffect(() => {
        fetch('/dishes')
            .then((response) => response.json())
            .then((data) => setDishes(data))
            .catch((error) => console.error('Error fetching dishes:', error));
    }, []);

    return (
        <div>
            <h1>Dishes</h1>
            <table>
                <thead>
                    <tr>
                        <th>Dish</th>
                        <th>City</th>
                        <th>Country</th>
                    </tr>
                </thead>
                <tbody>
                    {dishes.map((dish, index) => (
                        <tr key={index}>
                            <td>{dish.dish}</td>
                            <td>{dish.city}</td>
                            <td>{dish.country}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

export default Dishes;
